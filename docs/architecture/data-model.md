# Architecture: Data Model

This document defines the entities Memento persists, their fields, their invariants, and their relationships. The Zod schemas in `@psraghuveer/memento-schema` are the single source of truth; this file explains intent.

## The four entities

```text
┌──────────────┐  N    1  ┌──────────────┐
│ MemoryEvent  │─────────▶│   Memory     │
│  (audit log) │          │  (current)   │
└──────────────┘          └──────────────┘
                                │
                                │ owner
                                ▼
                          ┌──────────────┐
                          │  OwnerRef    │
                          └──────────────┘

┌──────────────┐
│ ConfigEvent  │   (independent audit log for config changes)
└──────────────┘
```

Memory is the current state. MemoryEvent is the append-only audit log; the source of truth for history. The redundancy is intentional: the current-state table makes reads cheap; the audit log makes reasoning provable.

## Memory

```ts
interface Memory {
  // — Immutable identity —
  id: MemoryId; // ULID, sortable, time-prefixed
  createdAt: Timestamp; // ISO-8601, set by core, never the caller
  schemaVersion: number; // bumped on breaking model changes
  scope: Scope; // see scope-semantics.md

  // — Owner —
  owner: OwnerRef; // always populated; currently always {type:'local',id:'self'}

  // — Mutable taxonomy —
  kind: MemoryKind; // discriminated union; see below
  tags: Tag[]; // free-form, lowercased, deduped; the `pack:` prefix is reserved (ADR-0020)
  pinned: boolean; // pinned memories never decay below threshold

  // — Content —
  content: string; // canonical content; what the model reads
  summary: string | null; // optional pre-computed summary for ranking

  // — Lifecycle —
  status: MemoryStatus; // active | superseded | forgotten | archived
  storedConfidence: number; // [0, 1], set at write time
  lastConfirmedAt: Timestamp; // last time something validated this memory;
  // denormalized from the audit log for speed

  // — Relationships —
  supersedes: MemoryId | null; // pointer to the memory this one replaces
  supersededBy: MemoryId | null; // back-pointer; nullable until superseded

  // — Embeddings (optional) —
  embedding: Embedding | null; // present only when local embedder is enabled
  embeddingStatus?: 'present' | 'pending' | 'disabled'; // wire-only
}

type MemoryKind =
  | { type: "fact" }
  | { type: "preference" }
  | { type: "decision"; rationale: string | null }
  | { type: "todo"; due: Timestamp | null }
  | { type: "snippet"; language: string | null };

type MemoryStatus = "active" | "superseded" | "forgotten" | "archived";

interface OwnerRef {
  type: "local" | "team" | "agent"; // currently only 'local' is emitted
  id: string;
}
```

### Invariants

- `id`, `createdAt`, `schemaVersion`, and `scope` are **immutable** after creation. Enforced by the repository layer; tested in property tests.
- `storedConfidence ∈ [0, 1]`. Validated by Zod.
- `status` transitions are explicit and gated by named commands. There is no path to flip `status` via `memory.update`.
- `supersedes` and `supersededBy` are mutual: if `B.supersedes = A`, then `A.supersededBy = B` and `A.status = 'superseded'`. Both are written in the same transaction.
- `lastConfirmedAt ≥ createdAt`. Enforced.
- `lastConfirmedAt` is a **denormalized cache** of the most recent `MemoryEvent` for this memory. `memento doctor` recomputes and verifies it.
- `owner` is always populated, even when always `{type:'local',id:'self'}`. The model is multi-user-ready from day one.
- `embedding` is present iff `retrieval.vector.enabled = true` **at the time the memory was written or last embedded**. Embedding model migration is explicit via `memento embedding rebuild`.
- `embeddingStatus` is a **wire-only projection field** computed at the command-output boundary. Storage and the repository layer do not produce it. Single-memory command responses (`write`, `read`, `update`, `confirm`, `forget`, `archive`, `restore`, `supersede`, `set_embedding`) and the list / search / context views all set it to `'present'` (vector exists), `'pending'` (`retrieval.vector.enabled = true` but the async embedder hasn't caught up yet — common right after a write), or `'disabled'` (vector retrieval is off). The field replaces the previous ambiguity where `embedding: null` could mean any of three different states.
- The `pack:` tag prefix is **reserved** ([ADR-0020](../adr/0020-memento-packs.md)). Only the `pack.install` path may stamp the canonical `pack:<id>:<version>` provenance tag; user-authored writes (`memory.write`, `memory.write_many`, `memory.extract`) reject any tag matching `^pack:` with `INVALID_INPUT`. The tag *is* the entire pack provenance — no new event variant or column is needed; querying `pack:<id>:<version>` returns exactly the memories a pack contributed, and uninstalling forgets them.

### Why `kind` is a discriminated union

Each memory kind has different ranking weights, decay parameters, and conflict semantics. A discriminated union makes those differences type-safe and forces every code path that switches on kind to use `assertNever` for exhaustiveness. A structural test asserts that for every `MemoryKind`, the decay registry, retrieval registry, and conflict registry have an entry.

This is principle 3 (Extensible) in code: adding a `MemoryKind` is a localized change with compile-time and test-time guardrails.

### Why content updates require supersession

`memory.update` is restricted to `tags`, `kind`, `pinned`, `sensitive` — taxonomy and presentation fields only. Content changes route through `memory.supersede`, which atomically writes a new memory and links the old one. This preserves history (every claim Memento ever made is recoverable) and makes "what did I believe at time T?" answerable from the audit log alone.

The error message returned when a caller attempts to mutate `content` via `update` points at `supersede` explicitly.

## MemoryEvent

```ts
interface MemoryEvent {
  id: EventId; // ULID
  memoryId: MemoryId;
  at: Timestamp;
  actor: ActorRef; // who/what caused this event
  type: MemoryEventType;
  payload: MemoryEventPayload; // typed by `type`
  scrubReport: ScrubReport | null; // present when scrubber modified content
}

type MemoryEventType =
  | "created"
  | "confirmed"
  | "updated" // tags/kind/pinned only
  | "superseded"
  | "forgotten"
  | "restored"
  | "archived"
  | "reembedded"
  | "imported"; // ADR-0019: stamped by `memento import` in default (collapse) mode
```

### Audit-log invariants

- The audit log is **append-only**. There is no command that deletes or modifies a `MemoryEvent`. Hard-deleting historical events would destroy the ability to reconstruct state and is rejected at the repository layer.
- For every `Memory`, there is at least one `created` event with `at = createdAt` and `actor = owner`.
- The `lastConfirmedAt` field on `Memory` is a denormalized cache: it equals `MAX(at)` over the lifecycle events for that memory. Every state-changing event bumps it (`created`, `confirmed`, `updated`, `superseded`, `restored`, `reembedded`, `imported`, plus the terminal `forgotten` and `archived` transitions, so the cache always reflects the most recent audit timestamp). `memento doctor` enforces the cache against the audit log.

### What the audit log enables

- **Time travel.** "What did Memento believe yesterday?" is a query, not an archaeological dig.
- **Debugging conflicts.** When two memories conflict, the audit shows when each became authoritative.
- **Privacy review.** Every redaction the scrubber performed is recoverable as a `scrubReport`.
- **Reproducible decay.** Effective confidence can be recomputed from the log alone.

## ConfigEvent

```ts
interface ConfigEvent {
  id: EventId;
  at: Timestamp;
  actor: ActorRef;
  key: ConfigKey; // typed; see config.md
  oldValue: unknown | null; // null on first set from a runtime source
  newValue: unknown | null; // null on `config.unset`
  source: ConfigSource;
}

type ConfigSource =
  | "default" // built-in compiled defaults
  | "user-file" // reserved for a future user-config-file loader
  | "workspace-file" // reserved for a future workspace-config-file loader
  | "env" // reserved for a future env-var loader
  | "cli" // programmatic `configOverrides` to `createMementoApp`, plus CLI `config.set`
  | "mcp"; // config.set during a server session
```

The `ConfigSource` enum is precedence-ordered (lowest to highest). Today only `default`, `cli`, and `mcp` are populated by the runtime; the file and env variants are reserved for future loaders and currently never emitted. The supported surface is documented in [config.md § What this deliberately omits](./config.md#what-this-deliberately-omits).

Config changes are first-class events. Every change to `ConfigKey` writes one. This means "why did retrieval behavior change last Tuesday?" is answerable from the database, not from shell history.

## Conflict

Conflict detection (see [conflict-detection.md](./conflict-detection.md)) records two related entities: the current-state `Conflict` row (so "list open conflicts" is a cheap read), and the append-only `ConflictEvent` log that drives it.

```ts
interface Conflict {
  id: ConflictId; // ULID
  newMemoryId: MemoryId; // the memory that triggered detection
  conflictingMemoryId: MemoryId; // the candidate it disagrees with
  kind: MemoryKind["type"]; // discriminator copied from the new memory
  evidence: unknown; // per-kind policy output; shape varies
  openedAt: Timestamp;
  resolvedAt: Timestamp | null;
  resolution: ConflictResolution | null;
}

type ConflictResolution =
  | "accept-new"
  | "accept-existing"
  | "supersede"
  | "ignore";

interface ConflictEvent {
  id: EventId;
  conflictId: ConflictId;
  at: Timestamp;
  actor: ActorRef; // detector for `opened`, user/agent for `resolved`
  type: ConflictEventType;
  payload: ConflictEventPayload; // typed by `type`
}

type ConflictEventType = "opened" | "resolved";
```

### Conflict invariants

- A `Conflict` row is `open` iff `resolvedAt === null` and `resolution === null`. Both fields move together; one-without-the-other is rejected.
- For every `Conflict`, there is exactly one `opened` event with `at = openedAt`, and at most one `resolved` event with `at = resolvedAt`.
- `ConflictEvent` is append-only; the same rejection rules as `MemoryEvent` apply.
- The `evidence` field is opaque at the data-model level. Per-kind policies define the shape; the conflict detector documents it.

### Why a separate audit log

Conflicts are not memories: they are observations about pairs of memories. Folding them into `MemoryEvent` would tangle two distinct event streams whose retention, indexing, and access patterns differ. A separate log keeps each one focused and lets `memento conflict scan` re-detect without rewriting memory history.

## Identifiers

- All `id` fields are ULIDs. They sort lexicographically by creation time, which we exploit for cursor-based pagination without a separate ordering column.
- `Timestamp` is ISO-8601 in UTC with millisecond precision.
- `Tag` is lowercased, trimmed, and deduplicated by the repository at write time.

## Schema versioning

`schemaVersion` is set at creation and never changes for that memory. Migrations transform older `schemaVersion` rows lazily on read or eagerly via `memento store migrate`. Migrations are append-only files in `packages/core/src/storage/migrations/`. Editing a shipped migration is a code-review rejection.

## What is deliberately not in the model

- **`relatedTo` / generic graph edges.** The only relationship between memories is supersession. Generic relations are easy to add and create unbounded modeling questions. We will revisit if a concrete use case demands it.
- **Per-memory ACL.** Memento has no multi-user model. `OwnerRef` exists as the extension point.
- **TTL / expiry.** Decay replaces expiry. A memory that is never confirmed approaches zero `effectiveConfidence` asymptotically, and `compact` archives it once below threshold. There is no clock-driven hard delete.
