# Architecture: Decay and Supersession

This document explains how Memento ages information and how new memories replace old ones. These two mechanisms together replace the more familiar but worse design of TTL-based expiry.

## The problem with TTL

TTL ("delete this memory in 30 days") fails in three ways:

1. **It throws away true things.** A fact does not become false because time passed.
2. **It forgets the wrong things first.** Important facts and trivial facts decay at the same rate.
3. **It is unrecoverable.** Once deleted, the system cannot explain why it lost confidence.

Memento replaces TTL with continuous decay over confidence and explicit supersession over content.

## Decay: continuous, recoverable, query-time

Every memory has a `storedConfidence ∈ [0, 1]` set at write time and a `lastConfirmedAt` timestamp updated whenever something validates the memory (a re-write with the same content, a `memory.confirm` call, an explicit `memory.update`).

At query time, the ranker computes:

```text
decayFactor(Δt, halfLife) = 0.5 ^ (Δt / halfLife)
effectiveConfidence       = storedConfidence × decayFactor(now − lastConfirmedAt, halfLife)
```

Half-life is per `MemoryKind`, configurable via `decay.halfLife.<kind>`. Default values:

| Kind         | Default half-life | Rationale                                        |
| ------------ | ----------------: | ------------------------------------------------ |
| `fact`       |           90 days | Most facts age slowly                            |
| `preference` |          180 days | User preferences are sticky                      |
| `decision`   |          365 days | Architectural decisions should not silently fade |
| `todo`       |           14 days | Stale todos are usually wrong                    |
| `snippet`    |           30 days | Snippets often get superseded by newer code      |

Defaults are starting points. Users tune via config.

### Why query-time, not write-time

Materializing `effectiveConfidence` would require re-writing every row whenever the clock advances or the half-life config changes. Computing at query time costs one floating-point multiply per candidate and is correct under any retroactive config change. The performance cost is negligible at the scales Memento targets.

### Pinned memories

If `pinned = true`, the ranker floors `effectiveConfidence` at `decay.pinnedFloor` (default `0.5`). Pinning is the user's commitment that this memory matters enough to ignore decay.

### Compact

`memento compact run` walks memories whose `effectiveConfidence` is below `decay.archiveThreshold` (default `0.05`) and have not been confirmed in `decay.archiveAfter` (default `365 days`), and transitions them to `archived`. Archived memories are excluded from default queries but remain in the database and the audit log. `memento memory restore` reverses.

This is the only background-style job, and it is explicit (run by the user or a scheduler). There is no daemon.

## Supersession: explicit, atomic, history-preserving

When a fact changes, the caller invokes `memory.supersede`:

```text
memory.supersede({
  supersedes: <oldMemoryId>,
  newContent: <…>,
  newKind?:    <…>,
  reason?:     <…>,
})
```

In a single transaction:

1. The new memory is written with `supersedes = oldMemoryId`.
2. The old memory is updated: `status = 'superseded'`, `supersededBy = newMemoryId`.
3. Two `MemoryEvent`s are emitted: a `created` for the new memory and a `superseded` for the old one.

Both writes succeed or both fail. There is no transient state where one is updated and the other is not.

### Why supersession over editing

`memory.update` is restricted to non-content fields (`tags`, `kind`, `pinned`, `sensitive`). Content changes always go through `supersede`. This guarantees:

- **History is preserved.** Every claim Memento ever made is recoverable.
- **Time travel works.** "What did I believe at time T?" is answerable from the audit log.
- **Conflicts are visible.** Supersession leaves a chain; conflicts during supersession surface as branches in the chain.

The error returned when a caller attempts a content edit via `update` points at `supersede` explicitly.

### Supersession chains

A memory can be superseded multiple times: `A → B → C`. Following the chain forward (`supersededBy`) reaches the current authoritative version; following it backward (`supersedes`) reaches the original. The ranker only considers chain heads (memories with `supersededBy = null` and `status = 'active'`) for default queries.

When two contemporaneous writes both supersede the same memory (e.g., two agents racing), they produce a fork: `A → B` and `A → C` both with `A.supersededBy` pointing somewhere. The first write wins on `A.supersededBy`; the second emits a conflict event. See [conflict-detection.md](conflict-detection.md) for how this surfaces.

## How decay and supersession compose

A memory that is superseded but historically true (e.g., the database engine _was_ PostgreSQL before the migration) decays at the same rate as any other superseded memory: it is excluded from default queries and slowly loses `effectiveConfidence`. The audit log retains it indefinitely.

A memory that is repeatedly confirmed (the agent re-writes the same fact each session) has its `lastConfirmedAt` advanced and its decay reset. This is correct: confirmation is evidence that the fact is still true.

A memory that is pinned and superseded enters `superseded` status; pinning protects from decay-driven archival but does not prevent supersession. Supersession is an explicit user (or agent) action; pinning is a hint about importance.

## What this enables

- **No catastrophic forgetting.** Half-lives are kind-aware and tunable.
- **Time-travel debugging.** "What did Memento think on date X?" is answerable.
- **Provable correctness of confidence.** `effectiveConfidence` is a pure function of `storedConfidence`, `lastConfirmedAt`, and `halfLife`. `memento doctor` recomputes and verifies it.

## What this deliberately omits

- **Per-memory custom half-life.** Half-lives are per kind. A per-memory override is easy to add later but adds complexity that has not yet been justified.
- **Learned decay.** No model fits the half-life from usage.
- **Eager re-ranking on confirmation.** Confirmations update `lastConfirmedAt` synchronously; ranker outputs catch up on the next query.
