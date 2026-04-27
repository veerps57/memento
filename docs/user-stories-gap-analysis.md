# User Stories — Gap Analysis

> A point-in-time check of [`docs/user-stories.md`](./user-stories.md)
> against the implementation in this repository. One paragraph per
> story. Each entry carries a verdict, the evidence that justifies it,
> and — where the verdict is anything other than _Met_ — a single line
> describing what would close the gap.
>
> This document does not modify the user-stories themselves. If a
> story turns out to be wrong (rather than the implementation being
> behind it), that is recorded here and noted as a follow-up to revise
> `docs/user-stories.md` in a separate change.

## How to read the verdicts

| Verdict | Meaning |
| --- | --- |
| **Met** | The criterion as written is satisfied today. |
| **Partial** | A user can rely on most of the criterion; one or more sub-clauses are not yet covered or not enforced. |
| **Unmet** | The criterion is not satisfied today, even though the story is in scope. |
| **Deferred** | The story is in scope but has been deliberately postponed; the rationale is recorded. |

Evidence cites concrete artefacts (files, ADRs, generated reference
pages) so this document can be re-checked mechanically next time.

## Run summary

- 40 stories evaluated.
- **27 Met**, **9 Partial**, **4 Unmet**, **0 Deferred**.
- The unmet items cluster on data portability and bulk-destructive
  ergonomics; the partials cluster on documented stability /
  introspection that exists in code but is not yet a published
  contract.

---

## P1 — Developer

### P1.1 Continuity across sessions — **Met**

The data plane is durable and identifies the right scopes on every
session. `memory.write` / `memory.list` / `memory.search` /
`memory.read` are all live (see
[docs/reference/mcp-tools.md](reference/mcp-tools.md)) and a fresh
process picks up state from the SQLite file under `MEMENTO_DB`. The
end-to-end test [packages/core/test/storage/concurrent-access.test.ts](../packages/core/test/storage/concurrent-access.test.ts)
confirms cross-opener visibility. **Closes:** —

### P1.2 Continuity across tools — **Met**

Memento speaks MCP over stdio (`@memento/server`) and projects the
same registry to a CLI (`@memento/cli`). Any MCP-capable client can
connect; the [README](../README.md#getting-started) lists Claude Code,
Cursor, Cline, Aider, VS Code MCP, Copilot. The registry is the
single source of truth ([ADR-0003](adr/0003-single-command-registry.md))
so the surface that one client sees is the same the next sees.
**Closes:** —

### P1.3 Local-first by default — **Met**

There are no outbound calls in the default install. The only optional
network use is the first download of the local embedder model
(`bge-small-en-v1.5`), gated behind `retrieval.vector.enabled` plus a
peer dep ([ADR-0006](adr/0006-local-embeddings-only-in-v1.md)). The
README and [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) state this
plainly. **Closes:** —

### P1.4 No vendor lock-in — **Met**

Shipped via `memento export` / `memento import` ([ADR-0013](adr/0013-portable-export-import.md)). The CLI emits a self-describing `memento-export/v1` JSONL artefact (header → records → sha256 footer) covering memories, memory_events, conflicts, conflict_events, and optionally embeddings. Importer enforces the schemaVersion handshake, the sha256 integrity check, and an explicit `--on-conflict skip|abort` policy with structured per-table counts. Round-trip, dry-run, idempotent re-import, abort-on-conflict, and corruption-detection paths are all under test in `packages/cli/test/lifecycle-{export,import}.test.ts` and `packages/core/test/portability/round-trip.test.ts`.

### P1.5 See and audit what was remembered — **Met**

Every state-changing op writes a `MemoryEvent` in the same
transaction (see
[packages/core/src/repository/memory-repository.ts](../packages/core/src/repository/memory-repository.ts)).
`memory.events` returns the per-memory log ascending or the
cross-memory log descending; `memory.read` plus `memory.events` give
the "when did this come into existence and what's happened since"
answer end-to-end. **Closes:** —

### P1.6 Correct or remove memory at will — **Met**

`memory.update` (taxonomy), `memory.supersede` (content),
`memory.forget` and `memory.restore` (reversible soft delete), and `memory.archive`
cover the spectrum. Each writes its own audit event so corrections are
observable. The split between `update` (taxonomy only) and
`supersede` (content) is intentional and called out in
[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md). **Closes:** —

### P1.7 Bulk-destructive operations are not surprising — **Met**

`memory.forget_many` and `memory.archive_many` ship as filter-driven
bulk verbs (ADR-0014). Both default to `dryRun: true` and require
`confirm: literal(true)` even for the rehearsal. The empty filter is
rejected to prevent "forget everything" by accident; `status` is
fixed by the verb rather than caller-controllable. Real applies are
capped by `safety.bulkDestructiveLimit` (default 1000, max 100_000);
rehearsals are uncapped so callers can size the blast radius first.
Per-row execution preserves the existing audit trail — N matched
rows produce N `forgotten` / `archived` events identical to N single
calls, including `reason` propagation. Tests in
`packages/core/test/commands/memory-bulk.test.ts` cover dry-run,
confirm, cap, idempotency, and per-row event emission.
**Closes:** —

### P1.8 Secrets never sit in memory in the clear — **Met**

The scrubber runs on every write
([packages/core/src/scrubber/engine.ts](../packages/core/src/scrubber/engine.ts)),
its activity is captured in `MemoryEvent` metadata, and there is a
dedicated `SCRUBBED` error class for content that is wholly
sensitive. The default rule set is the conservative bias documented
in [docs/architecture/scrubber.md](architecture/scrubber.md).
**Closes:** —

### P1.9 The redaction layer is conservative and tunable — **Met**

`scrubber.rules` is a config key with a typed schema and runtime
mutability ([packages/schema/src/config-keys.ts](../packages/schema/src/config-keys.ts)).
`scrubber.enabled=false` is honoured but the bootstrap logs at WARN.
Users can extend rules without touching code; the audit event records
exactly which rules fired. **Closes:** —

### P1.10 Different contexts have different memory — **Met**

Scope is a first-class field on every memory, immutable after
creation ([packages/schema/src/scope.ts](../packages/schema/src/scope.ts)),
and the scope resolver composes per-dimension resolvers
([docs/architecture/scope-semantics.md](architecture/scope-semantics.md)).
A read scoped to repo A cannot return a memory whose scope is repo B.
**Closes:** —

### P1.11 Layered context I can reason about — **Met**

The scope-semantics doc spells out the layering rule (`session ⊕
branch ⊕ repo ⊕ workspace ⊕ global`) and the ranker boost is
exposed via `retrieval.scopeBoost`. A repo-specific memory and a
global memory both surface for the same query, and the more-specific
scope ranks higher. **Closes:** —

### P1.12 Zero-friction install and verify — **Met**

`npx memento serve` is the install; `npx memento doctor` is the
verify. Doctor checks Node version, db writability, embedder presence,
and decay statistics. Both are wired up in
[packages/cli/src/lifecycle/](../packages/cli/src/lifecycle/) and
covered by tests. **Closes:** —

### P1.13 Honest reporting of what doesn't work — **Met**

[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) is real and
maintained; it distinguishes "out of scope" from "active limitations"
and is required updating per release in the contributor docs. Several
limits we hit during this audit (vector backend brute-force, embedder
first-run, model migration explicitness, audit retention) are listed
there with both the why and the workaround. **Closes:** —

### P1.14 Optional, opt-in capability — **Met**

`@memento/embedder-local` is a separate workspace package; it is loaded
through a typed interface only when `retrieval.vector.enabled` is
true. The default install runs without it
([ADR-0006](adr/0006-local-embeddings-only-in-v1.md)). **Closes:** —

### P1.15 Pick up where I left off on a new machine — **Met**

Closed by the same `memento export` / `memento import` pair that closes P1.4. The new-machine scenario is exercised in `packages/cli/test/lifecycle-import.test.ts` (`round-trips an artefact into a fresh DB`): export from a seeded source DB → import into an empty migrated DB → applied counts match, audit history is preserved by re-emitting the original `memory_events` rows, and an explicit `--on-conflict abort` mode plus structured `applied`/`skipped` tallies provide the "this item could not be carried forward" report.

---

## P2 — AI assistant

### P2.1 A small, learnable surface — **Met** (ADR-0015 + `packages/cli/test/deprecation.contract.test.ts`)

The surface is small (26 tools, listed in
[docs/reference/mcp-tools.md](reference/mcp-tools.md)) and the
registry rejects duplicate names at build time. `Command.deprecated`
exists as a typed field
([packages/core/src/commands/types.ts](../packages/core/src/commands/types.ts))
so a deprecation cycle is _representable_, but no command currently
uses it and there is no published policy stating "deprecated names
continue to work for at least one release with a structured signal."
The story's stability sub-clause is therefore not yet a contract.
**Closes:** publish the deprecation policy (one ADR, one paragraph in
`CONTRIBUTING.md`), and add a contract test that any `deprecated`
command is still resolvable via both surfaces with an MCP/CLI hint.

### P2.2 Predictable, structured input and output — **Met**

Every command declares Zod input/output schemas validated by the
generic execute path
([packages/core/src/commands/execute.ts](../packages/core/src/commands/execute.ts)).
Surfaces project the schemas. `system.info` exposes capability/version
and `config.list` exposes the configuration surface; both let a caller
self-orient before calling anything else. **Closes:** —

### P2.3 Errors I can act on — **Met**

`MementoError` is a closed enum of nine codes
([packages/schema/src/result.ts](../packages/schema/src/result.ts))
with per-code descriptions generated into
[docs/reference/error-codes.md](reference/error-codes.md).
`repoErrorToMementoError` maps thrown exceptions into stable codes
([packages/core/src/commands/errors.ts](../packages/core/src/commands/errors.ts))
including `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `IMMUTABLE`,
`CONFIG_ERROR`, `SCRUBBED`, `STORAGE_ERROR`, `EMBEDDER_ERROR`,
`INTERNAL`. **Closes:** —

### P2.4 Idempotency under retry — **Met**

`memory.write` accepts a per-call `clientToken`; a repeat with the
same token returns the original memory id without creating a
duplicate. Tests exercise the across-write and within-batch cases
([packages/core/test/commands/memory.test.ts](../packages/core/test/commands/memory.test.ts)).
**Closes:** —

### P2.5 Batching without loss of safety — **Met**

`memory.write_many` runs the whole batch in a single transaction; any
rejection rolls back every item. Per-item `clientToken` is honoured
and idempotency holds against earlier items in the same batch. The
batch ceiling is `safety.batchWriteLimit` (default 100, min 1, max
10000). **Closes:** —

### P2.6 Disambiguation by context — **Met**

Scope is required on `memory.write` and accepted on every read.
`system.list_scopes` lets a caller discover which scopes the user has
populated before issuing scoped reads. **Closes:** —

### P2.7 Recall that ranks relevance — **Met**

`memory.search` returns each result with `score` and a per-component
`breakdown` (`fts`, optional `vector`, `recencyBoost`, `confidence`,
`scopeBoost`) — see
[packages/core/src/commands/memory/search.ts](../packages/core/src/commands/memory/search.ts).
The ranker is deterministic for fixed inputs and configurable via
`retrieval.*`. Conflict surfacing is a presentation concern and does
not change order or scores (note in the same file). **Closes:** —

### P2.8 Lifecycle that I can drive — **Met**

`MemoryStatus` is `active | superseded | forgotten | archived`
([packages/schema/src/memory.ts](../packages/schema/src/memory.ts)).
Supersession sets `supersededBy` so the pointer chain is traceable.
The repository enforces the transition graph
([memory-repository.ts](../packages/core/src/repository/memory-repository.ts)).
**Closes:** —

### P2.9 Conflict surfacing without blocking — **Met**

Conflict detection is a post-write hook; it does not block the
response. Conflicts are reachable via `conflict.list` /
`conflict.read` / `conflict.events` / `conflict.resolve`, and
`conflict.scan` recovers from missed hooks
([ADR-0005](adr/0005-conflict-detection-post-write-hook.md)).
**Closes:** —

### P2.10 Self-correcting decay — **Met**

`effectiveConfidence` decays by half-life keyed on `kind`. The decay
math runs at query time (lazy) — see
[ADR-0004](adr/0004-lazy-query-time-decay.md) and
[docs/architecture/decay-and-supersession.md](architecture/decay-and-supersession.md).
The ranker exposes the effective confidence so the assistant can
surface the age signal. **Closes:** —

### P2.11 Pinning what must not decay — **Met**

`pinned: boolean` is on `Memory`; pinned items respect
`decay.pinnedFloor`. Audit events (created / updated) capture who
pinned and when. **Closes:** —

### P2.12 Self-introspection — **Met**

`system.info` returns version, schema version, db path, vector status,
embedder model+dimension, and per-status counts. `config.list` is the
canonical config dump. `system.list_scopes` enumerates populated
scopes. All three are read-only and side-effect-classified `read`.
**Closes:** —

### P2.13 Privacy-aware writes — **Met** (`docs/architecture/privacy.md` + `packages/core/test/privacy/sensitive-embedding.test.ts`)

`sensitive: boolean` is a first-class field on `Memory` (added in
ADR-0012 §3) and `privacy.redactSensitiveSnippets` controls whether
`memory.list` / `memory.search` project sensitive memories to a
`{ content: null, redacted: true }` view. `memory.read` always returns
full text — that's the documented contract. The sub-clause "the
system's own behaviour around that property is documented" is met for
read paths; documentation of how the sensitivity flag interacts with
embedding (do we embed sensitive content? do we exclude it from
vector candidate sets?) is not yet explicit. **Closes:** one short
section in `docs/architecture/scrubber.md` (or a new `privacy.md`)
nailing down the embedding-side behaviour, plus a test fixture
asserting it.

---

## P3 — Maintainer

### P3.1 The "why" survives the "how" — **Met**

Twelve numbered ADRs in [docs/adr/](adr/) — including the load-bearing
ones (storage, registry, decay model, conflict hook, embeddings
scope, MCP naming, safety gates). Each follows the published
template. The architecture overview cross-references the ADRs that
explain its claims. **Closes:** —

### P3.2 Surfaces evolve in lockstep — **Met**

The CLI/MCP parity contract is enforced by
[packages/cli/test/parity.contract.test.ts](../packages/cli/test/parity.contract.test.ts)
and by the registry's structural rule that every command declares its
surfaces set. Bootstrap tests assert the v1 command set explicitly
([packages/core/test/bootstrap.test.ts](../packages/core/test/bootstrap.test.ts)).
A command that drops `mcp` or `cli` from its surfaces fails the
contract test. **Closes:** —

### P3.3 Quality bar is mechanically enforced — **Met**

`pnpm verify` runs lint → typecheck → build → unit tests → e2e →
docs:lint → docs:check. `lefthook` runs typecheck + biome on every
commit. Vitest config sets 90% coverage thresholds on lines, branches,
functions, statements ([vitest.config.ts](../vitest.config.ts)).
**Closes:** —

### P3.4 Schema and storage evolve safely — **Met** (`MementoMigrationDowngradeError` + downgrade tests in `packages/core/test/storage/migrate.test.ts`)

Migrations are append-only and hash-checked. `memento store migrate`
provides the lifecycle for upgrade. The "older client able to read the
data it understood before" half is met; the "downgrade either works
or fails up-front with a clear message" half is not yet a tested
contract — there is no automated check that opens a v(N) database
with a v(N-1) build and asserts the right `STORAGE_ERROR` /
`CONFIG_ERROR`. **Closes:** add a downgrade integration test that
opens a future-versioned `schema_version` row with the current build
and asserts a single, structured error.

### P3.5 Configuration is a contract — **Met**

[packages/schema/src/config-keys.ts](../packages/schema/src/config-keys.ts)
is the single source of truth: every key has a `schema`, `default`,
`mutable`, and `description`. The reference page
[docs/reference/config-keys.md](reference/config-keys.md) is generated
from it. The store enforces immutability and rejects writes that fail
the per-key schema with `CONFIG_ERROR`. **Closes:** —

### P3.6 Failures are loud and scoped — **Met**

Error codes mirror subsystem boundaries (storage, embedder, config,
scrubber, repo). Doctor surfaces per-subsystem diagnostics. The error
docs explicitly say what a caller should do for each code. **Closes:**
—

### P3.7 Boundaries are typed once and projected — **Met**

`@memento/schema` exports Zod schemas that flow into validation,
storage row mappers, generated docs, and tests. A field-shape change
ripples through one declaration (`MemorySchema`,
`ConfigKeyDescriptor`, etc.); the build catches the disagreements.
This is the lever P2.2/P2.3 ride on. **Closes:** —

### P3.8 New surfaces are additive — **Met**

The MCP and CLI adapters are pure projections of the registry. Each is
a single small file ([build-server.ts](../packages/server/src/build-server.ts),
[registry-run.ts](../packages/cli/src/registry-run.ts)) and writes no
operation logic. **Closes:** —

### P3.9 Optional dependencies stay optional — **Met**

`@huggingface/transformers` is a peer dep of `@memento/embedder-local`,
which itself is loaded by `@memento/core` only at runtime via a typed
interface. A default install never resolves it
([ADR-0006](adr/0006-local-embeddings-only-in-v1.md)). **Closes:** —

### P3.10 Performance characteristics are knowable — **Met** (`docs/architecture/performance.md`)

Decay is documented as O(1)-per-row at query time
([decay-and-supersession.md](architecture/decay-and-supersession.md));
the brute-force vector backend is documented as scaling linearly with
active embedded rows ([KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md)).
But there is no systematic per-operation table — `memory.list` filter
costs, `memory.search` FTS path, `conflict.scan` candidate set growth,
etc. — and no documented break-even thresholds. **Closes:** add
`docs/architecture/performance.md` with a row per operation:
asymptotic cost, dominant factor, observed break-even, swap-out
criterion. It is a write-up, not new code.

### P3.11 Honesty about limits — **Met**

[KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md) is the single file. It
is referenced from the README and from the architecture entry. It is
updated per release as part of the contributor workflow. **Closes:** —

### P3.12 Onboard human and AI contributors equivalently — **Met**

[AGENTS.md](../AGENTS.md) is the canonical instruction set;
`CLAUDE.md` and `.github/copilot-instructions.md` are thin pointers.
[CONTRIBUTING.md](../CONTRIBUTING.md) covers branching/commits/PR
flow for both human and AI contributors. The same gates apply.
**Closes:** —

### P3.13 Reversibility of operational actions — **Met**

Every state change writes an audit event, so "who, when, what was
here before" is answerable. Both reversible sinks out of `active`
are reversible at the API level: `memory.restore` accepts both
`forgotten` and `archived` source states and emits a `'restored'`
event in either case. The "_or_ gated behind explicit confirmation"
half is now closed by ADR-0014: `memory.forget_many` and
`memory.archive_many` ship with `dryRun: true` defaults,
mandatory `confirm: literal(true)` (even in dry-run), and a
`safety.bulkDestructiveLimit` cap on real applies (see P1.7).
**Closes:** —

### P3.14 Documentation is generated, not narrated — **Met**

`docs:generate` regenerates `mcp-tools.md`, `cli.md`, `config-keys.md`,
`error-codes.md` from source ([packages/core/src/docs/](../packages/core/src/docs/)).
`docs:check` fails the build if the generated artefacts drift from
their sources. Prose pages are reserved for the why. **Closes:** —

---

## Cross-cutting outcomes — recap

The implementation honours the cross-cutting outcomes as follows:

1. **Leave at any time without loss.** Partial, dragged down by P1.4
   (no export command) and by P1.15 (no documented import path for a
   new machine).
2. **Audit and correct anything.** Met for individual edits; partial
   for bulk and for one-way state transitions (P1.7, P3.13).
3. **Predictable, structured behaviour.** Met (P2.1–P2.5).
4. **Context honoured.** Met.
5. **Memory has a lifecycle.** Met.
6. **Honest about limits.** Met.
7. **Surfaces are projections of one definition.** Met.
8. **Sensitive material non-default.** Met for read paths; partial
   for the embedding side (P2.13).
9. **Optional capability stays optional.** Met.
10. **Decisions outlive their authors.** Met.

## Suggested follow-ups, ordered

The unmets and partials translate to a small, bounded backlog:

1. **`memento export` / `memento import`** — closes P1.4, P1.15, and
   the first cross-cutting outcome.
2. **`memory.forget_many` / `memory.archive_many` with `dryRun`/
   `confirm`** — closes P1.7 and the second cross-cutting outcome.
3. **~~`memory.unarchive`~~** — _resolved_: `memory.restore` was
   widened to accept `archived → active` (single inverse for both
   reversible sinks). No new command needed.
4. **Embedding-side behaviour for `sensitive: true`** — closes
   P2.13's open sub-clause.
5. **Deprecation policy** — closes P2.1's stability sub-clause and
   prepares the ground for P3.4's downgrade test.
6. **Downgrade integration test** — closes P3.4.
7. **`docs/architecture/performance.md`** — closes P3.10.

None of these touch the load-bearing design. Each is additive, each
fits inside a single ADR (when one is needed) and a focused PR.

## Changelog

- _Created 2026-04-26_ — initial gap analysis against the user-stories
  doc as it stood at commit `1eb70cd`.
- _Updated 2026-04-26_ — P3.13: `memory.restore` widened to accept
  `archived → active`, so the reversibility half of the story is now
  Met. P3.13 stays Partial pending the bulk-destructive safety gates
  (P1.7).
