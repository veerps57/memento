# @psraghuveer/memento-core

The Memento engine. Owns the storage scaffold, repositories, the scope resolver, the scrubber, the decay engine, the conflict detection workflow, and the embedding hook.

This package is **transport-agnostic**. Nothing in here speaks MCP or CLI; adapters live in [`@psraghuveer/memento-server`](../server) and [`@psraghuveer/memento`](../cli). See ADR [0003 — Single command registry](../../docs/adr/0003-single-command-registry.md).

The retrieval pipeline ships as the `memory.search` command with FTS always-on; brute-force vector candidate generation activates behind `retrieval.vector.enabled` when an `EmbeddingProvider` is wired into the host (the native `sqlite-vec` backend is still pending) — see [`docs/architecture/retrieval.md`](../../docs/architecture/retrieval.md).

## Install

```bash
pnpm add @psraghuveer/memento-core @psraghuveer/memento-schema better-sqlite3
```

`better-sqlite3` is also a direct dep here, so most callers do not need to install it explicitly. `@psraghuveer/memento-schema` is the source of truth for the data shapes (`Memory`, `MemoryEvent`, `Conflict`, `Embedding`, `Scope`, etc.); import those types from there.

## Public API

All exports are re-exported from the package root:

```ts
import {
  // Storage
  openDatabase,
  migrateToLatest,
  MIGRATIONS,
  // Repositories
  createMemoryRepository,
  createEventRepository,
  ulid,
  // Scope
  effectiveScopes,
  resolveEffectiveScopes,
  scopeKey,
  // Scrubber
  applyRules,
  DEFAULT_SCRUBBER_RULES,
  // Decay
  compact,
  decayFactor,
  effectiveConfidence,
  DEFAULT_DECAY_CONFIG,
  MS_PER_DAY,
  // Conflict
  createConflictRepository,
  detectConflicts,
  runPolicy,
  CONFLICT_POLICIES,
  DEFAULT_POLICY_CONFIG,
  // Embedding
  reembedAll,
} from "@psraghuveer/memento-core";
```

### Storage

| Export                                                                                     | Purpose                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `openDatabase(options)`                                                                    | Open a SQLite database; sets `WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout`, `temp_store=MEMORY`. Returns `{ raw, db, close }`. |
| `migrateToLatest(db, MIGRATIONS)`                                                          | Idempotent migration runner. Bookkeeping in `_memento_migrations`; each migration runs in its own transaction.                                  |
| `MIGRATIONS`                                                                               | The ordered, append-only migration list. Pass to `migrateToLatest`.                                                                             |
| `MementoDatabase`, `MementoSchema`, `Migration`, `MigrationOutcome`, `OpenDatabaseOptions` | Types.                                                                                                                                          |

```ts
import { openDatabase, migrateToLatest, MIGRATIONS } from "@psraghuveer/memento-core";

const handle = openDatabase({ path: "./memento.db" });
await migrateToLatest(handle.db, MIGRATIONS);
```

### Repositories

| Export                                                                                                                                                    | Purpose                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMemoryRepository(db, deps?)`                                                                                                                       | The gatekeeper for memory writes. `write`, `read`, `list`, `supersede`, `confirm`, `update`, `forget`, `restore`, `archive`, `setEmbedding`. Every successful write returns a schema-parsed `Memory`. |
| `createEventRepository(db)`                                                                                                                               | Read-only audit log: `listForMemory`, `listRecent`, `latestForMemory`, `countForMemory`.                                                                                                              |
| `ulid()`                                                                                                                                                  | Crockford ULID generator with per-process intra-millisecond monotonicity.                                                                                                                             |
| `MemoryRepository`, `MemoryWriteInput`, `MemoryListFilter`, `MemoryUpdatePatch`, `EmbeddingInput`, `EventRepository`, `EventListFilter`, `RepositoryDeps` | Types.                                                                                                                                                                                                |

`RepositoryDeps` accepts injectable `clock`, `memoryIdFactory`, `eventIdFactory`, and `scrubber` — used by tests and by adapters that want a non-default scrubber configuration.

```ts
import { createMemoryRepository, DEFAULT_SCRUBBER_RULES } from "@psraghuveer/memento-core";

const repo = createMemoryRepository(handle.db, {
  scrubber: { rules: DEFAULT_SCRUBBER_RULES, enabled: true },
});

const memory = await repo.write(
  {
    scope: { type: "global" },
    owner: { type: "local", id: "me" },
    kind: { type: "fact" },
    tags: ["preferences"],
    pinned: false,
    content: "tabs over spaces",
    summary: null,
    storedConfidence: 0.9,
  },
  { actor: { type: "cli" } },
);
```

### Scope

| Export                                   | Purpose                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolveEffectiveScopes(active, filter)` | Compose a layered read set from the live `ActiveScopes` and a `ScopeFilter` (`'all'`, `'effective'`, or an explicit list). Output goes straight into `MemoryListFilter.scope`. |
| `effectiveScopes(active)`                | The default `'effective'` layering.                                                                                                                                            |
| `scopeKey(scope)`                        | Stable, structural key for a `Scope` — equality / dedup-friendly.                                                                                                              |
| `ActiveScopes`, `ScopeFilter`            | Types.                                                                                                                                                                         |

### Scrubber

| Export                       | Purpose                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `applyRules(rules, content)` | Pure first-match-wins rule engine; returns `{ scrubbed, report }`. Tokeniser-based placeholder render.         |
| `DEFAULT_SCRUBBER_RULES`     | The shipped rule set (emails, JWTs, secrets, etc. — see [`scrubber.md`](../../docs/architecture/scrubber.md)). |
| `ScrubResult`                | Type.                                                                                                          |

The repository wires the scrubber into `write` and `supersede` when `RepositoryDeps.scrubber.enabled` is `true`; the resulting `ScrubReport` is persisted on the corresponding `MemoryEvent`.

### Decay & compaction (ADR 0004)

| Export                                                            | Purpose                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decayFactor(ageMs, halfLifeMs)`                                  | The exponential decay function used by retrieval.                                                                                                                                                                                                                      |
| `effectiveConfidence(memory, now, config)`                        | `storedConfidence × decayFactor(...)` with the pinned floor applied.                                                                                                                                                                                                   |
| `compact(repo, options)`                                          | Archival pass: walks `active` + `forgotten` rows whose effective confidence has fallen below `archiveThreshold` and ages past `archiveAfterMs`, archives them. Pinned memories are floored at `pinnedFloor` (default `0.5`) and never archived for confidence reasons. |
| `DEFAULT_DECAY_CONFIG`                                            | Per-kind half-lives + pinned floor + archive threshold.                                                                                                                                                                                                                |
| `MS_PER_DAY`                                                      | Convenience constant.                                                                                                                                                                                                                                                  |
| `DecayConfig`, `HalfLifeByKind`, `CompactOptions`, `CompactStats` | Types.                                                                                                                                                                                                                                                                 |

Decay is **lazy**: `effectiveConfidence` is computed at query time and never persisted. `compact` is the only writer that uses decay and runs as a scheduled pass.

### Conflict detection (ADR 0005)

| Export                                                                                                                                                                                                 | Purpose                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createConflictRepository(db, deps?)`                                                                                                                                                                  | `open`, `resolve`, `list`, `read`, `events`. Each mutation is one transaction (row + event).                                                         |
| `detectConflicts(memory, deps, options)`                                                                                                                                                               | Standalone pass over candidates. Default scope strategy is `'same'` (the memory's own scope); pass `scopes` explicitly to widen to an effective set. |
| `runPolicy(next, candidate, config)`                                                                                                                                                                   | Pure per-pair policy dispatch. Short-circuits on identity, kind mismatch, and supersedes-relations.                                                  |
| `CONFLICT_POLICIES`                                                                                                                                                                                    | Total registry over `MemoryKind['type']`.                                                                                                            |
| `DEFAULT_POLICY_CONFIG`                                                                                                                                                                                | `{ factOverlapThreshold: 3 }`.                                                                                                                       |
| `ConflictRepository`, `ConflictRepositoryDeps`, `ConflictListFilter`, `ConflictOpenInput`, `ConflictPolicy`, `ConflictPolicyConfig`, `DetectConflictsOptions`, `DetectConflictsResult`, `PolicyResult` | Types.                                                                                                                                               |

`detectConflicts` is **not** automatically called from `MemoryRepository.write`. Adapters compose the two: write the memory, then call `detectConflicts` (post-commit, time-bounded). This is by design (see ADR 0005).

```ts
import {
  detectConflicts,
  createConflictRepository,
  createMemoryRepository,
} from "@psraghuveer/memento-core";

const memoryRepo = createMemoryRepository(handle.db);
const conflictRepo = createConflictRepository(handle.db);

const written = await memoryRepo.write(input, { actor });
const { scanned, opened } = await detectConflicts(
  written,
  { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
  { actor },
);
```

### Embedding (ADR 0006)

| Export                                           | Purpose                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reembedAll(repo, provider, options)`            | Bulk driver: walks active memories, identifies missing or stale (different `model` / `dimension`) rows. Attempts batch embedding via `EmbeddingProvider.embedBatch` when available (ADR-0017); on batch failure, falls back to per-row `embed()` calls so a single bad input doesn't take down the entire batch. Each embedding write is a separate `MemoryRepository.setEmbedding` transaction; provider errors are recorded as skips and don't halt the batch. |
| `embedBatchFallback(provider, texts)`            | Helper that delegates to `provider.embedBatch` when present, falling back to sequential `provider.embed` calls when it is not.                                                                                                                             |
| `EmbeddingProvider`                              | The contract every embedder satisfies — `model`, `dimension`, `embed(text)`, and an optional `embedBatch(texts)` for batch inference. The local implementation lives in `@psraghuveer/memento-embedder-local`.                                                          |
| `ReembedOptions`, `ReembedResult`, `ReembedSkip` | Types.                                                                                                                                                                                                                                                     |

`MemoryRepository.setEmbedding(id, input, ctx)` is the single write surface for embeddings. It validates through `EmbeddingSchema` (catches dimension mismatch before opening a transaction) and emits a `reembedded` event in the same transaction as the row update. Allowed only on `active` memories.

The `memory.set_embedding` command on top of this repo method adds a configured-embedder check: when the host has wired an `EmbeddingProvider`, callers whose `(model, dimension)` disagree with the configured one are rejected with `CONFIG_ERROR` so the vector store stays consistent with the search-time invariant. Hosts that don't wire a provider keep the legacy "set raw vector for testing" affordance — useful for offline test fixtures that pre-seed embeddings.

```ts
import { reembedAll } from "@psraghuveer/memento-core";

const result = await reembedAll(repo, provider, {
  actor: { type: "cli" },
});
// result.embedded: MemoryId[]
// result.skipped:  ReembedSkip[]  (reason: 'up-to-date' | 'error')
```

### Commands (ADR 0003)

The single command registry. Every operation Memento exposes is defined exactly **once** as a `Command` — name, side-effect class, Zod input/output schemas, and a `Result`-returning handler. Adapters (`@psraghuveer/memento-server` for MCP, `@psraghuveer/memento` for the CLI) bind to the same registry; a contract test will assert parity once the adapters land.

| Export                                                         | Purpose                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRegistry()`                                             | Builder for an in-memory command registry. Returns `{ register, freeze }`. After `freeze()`, the registry is read-only and exposes `get(name)`, `has(name)`, `list()` (registration order).                                                                             |
| `executeCommand(command, rawInput, ctx)`                       | The validating execute path. Parses `rawInput` against the input schema (rejects with `INVALID_INPUT`), runs the handler, then validates the success value against the output schema (rejects drift with `INTERNAL`). Handler-returned `err(...)` results pass through. |
| `Command<I, O>`, `AnyCommand`                                  | The command contract. Generic over its Zod input/output types so handler bodies see precise inferred shapes.                                                                                                                                                            |
| `CommandContext`                                               | The per-invocation context. Currently `{ actor: ActorRef }`; repository handles are injected per-batch when commands are registered.                                                                                                                                    |
| `CommandSideEffect`                                            | Closed enum: `'read' \| 'write' \| 'destructive' \| 'admin'`. Adapters apply surface-appropriate policy from this rather than re-deriving it from the name.                                                                                                             |
| `CommandSurface`                                               | Closed enum: `'mcp' \| 'cli'`. Each command lists the surfaces it must appear on.                                                                                                                                                                                       |
| `CommandRegistry`, `CommandRegistryBuilder`, `CommandMetadata` | Supporting types.                                                                                                                                                                                                                                                       |

The registry only owns the contract here — concrete commands (memory, conflict, embedding, compact) are registered via the factory helpers exported alongside (`createMemoryCommands`, `createConflictCommands`, `createEmbeddingCommands`, `createCompactCommands`); adapters in `@psraghuveer/memento-server` and `@psraghuveer/memento` consume the frozen registry.

```ts
import { createRegistry, executeCommand } from "@psraghuveer/memento-core";

const registry = createRegistry()
  .register(memoryWriteCommand)
  // .register(/* ... */)
  .freeze();

const out = await executeCommand(registry.get("memory.write")!, rawInput, {
  actor: { type: "cli" },
});
```

## Design notes

- **Schema-parsed everything.** Every row is parsed by the schema on the way out of the repository. Drift is impossible to observe from the public surface; failures surface at the parser, not deep in business logic.
- **Single-transaction writes.** Every state mutation is one transaction over `(row update, event insert)`. Failures roll back both halves.
- **Standalone callables.** `detectConflicts` and `reembedAll` do not auto-fire from `MemoryRepository.write`. Higher layers compose the pieces; this keeps the engine layer's contract simple and the timing decisions (post-commit, time-bounded) where they belong.
- **Retrieval ships as `memory.search`.** FTS is always on; the ranker composes BM25 with decay-aware effective confidence, pinned bias, and recency. Vector candidate generation is gated on `retrieval.vector.enabled`; when on (with an `EmbeddingProvider` wired in), the brute-force scanner unions cosine-similarity hits with FTS hits and the ranker scores the union. The native `sqlite-vec` backend is still pending. Adapters get retrieval for free by re-projecting the registry.

## References

- [Architecture overview](../../docs/architecture/overview.md)
- [Data model](../../docs/architecture/data-model.md)
- [Scope semantics](../../docs/architecture/scope-semantics.md)
- [Decay & supersession](../../docs/architecture/decay-and-supersession.md)
- [Conflict detection](../../docs/architecture/conflict-detection.md)
- [Scrubber](../../docs/architecture/scrubber.md)
- [Retrieval](../../docs/architecture/retrieval.md)
- ADR [0001](../../docs/adr/0001-sqlite-as-storage-engine.md), [0003](../../docs/adr/0003-single-command-registry.md), [0004](../../docs/adr/0004-lazy-query-time-decay.md), [0005](../../docs/adr/0005-conflict-detection-post-write-hook.md), [0006](../../docs/adr/0006-local-embeddings-only-in-v1.md)
