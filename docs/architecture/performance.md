# Architecture: Performance

This document describes the performance envelope of Memento today: what each operation costs, what dominates that cost, where the break-even points sit, and the criterion for swapping each piece out. It is written from first principles — every claim either follows from the data model or is a measured limit, not a goal.

The goal is honesty. If an operation is `O(n)` we say so, and we name the threshold at which it stops being acceptable. We prefer a small number of well-understood algorithms (a tree-walk, a B-tree lookup, an FTS5 match, a linear cosine scan) to clever ones, because clever ones hide their failure modes.

## Per-operation envelope

`n` is the number of active memories in scope (after `scope_type` and `status='active'` filters). `m` is the candidate set produced by the FTS / vector / pin stage. `k` is the requested result count.

| Operation               | Asymptotic cost                          | Dominant factor                                                       | Observed break-even (1.x)                                         | Swap-out criterion                                                                                  |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `memory.read`           | `O(1)`                                   | Single primary-key lookup on `memories.id`                            | Sub-millisecond at any store size we support                      | Never — this is a B-tree probe                                                                      |
| `memory.list`           | `O(log n + p)`                           | Scope-prefix + `created_at desc` indexed scan; `p` = page size        | Linear in page size; index keeps it independent of total store    | Add a covering index if a new filter starts dominating the scan                                     |
| `memory.write`          | `O(1)` storage + `O(d)` embedding (async) | One insert + transactional FTS trigger + fire-and-forget embedder call via `afterWrite` hook (`d` = vector dimension) | Insert is sub-millisecond; embedding runs async and does not block the write response | The async embed is already non-blocking; batch multiple writes if throughput becomes a goal |
| `memory.search` (FTS)   | `O(log n + m + m log k)`                 | FTS5 token match + ranker top-`k` heap                                | Millisecond-scale at tens of thousands of rows                    | Replace SQLite FTS5 only if a tokenizer requirement (e.g. stemming) forces it                       |
| `memory.search` (vector) | `O(n_e · d)` per query                   | Brute-force cosine scan over every embedded active row (`n_e ≤ n`)    | Acceptable at low thousands; degrades linearly above              | Switch `retrieval.vector.backend` from `brute-force` to a native ANN (`sqlite-vec`) when `n_e` exceeds the configured threshold |
| `conflict.list`         | `O(log n + p)`                           | Indexed scan over `conflicts` by `status`                             | Same as `memory.list`                                             | Add a status-leading covering index if a new filter dominates                                       |
| `conflict.scan`         | `O(n · c)`                               | For each new candidate, evaluate up to `c` peers in the same `(scope, kind)` bucket; `c` is bounded by config | Quadratic only inside a bucket; total work is linear in the bucket-size sum | Move to a content-addressed index keyed on a learned similarity signature when `c` regularly hits the cap |
| `compact.run`           | `O(n)` per pass, `O(1)` per row          | Single sweep over active rows applying decay + supersession (see [decay-and-supersession.md](decay-and-supersession.md)) | Linear in store size; runs out of band                            | Partition the sweep by scope when wall-clock matters; the per-row work is already constant          |
| `embedding.rebuild`     | `O(n_e · d)`                             | One embedder call per active row missing or stale-stamped vector      | Linear; long-running on cold start                                | Batch embedder calls (provider permitting) and parallelise across cores                             |

Notes:

- `n_e` is the count of active rows that already carry an embedding for the current model. Rows without an embedding (because vector retrieval was disabled when they were written, or because the model changed) are skipped by vector search and counted separately by `embedding.rebuild`.
- "Indexed" means an index that already exists in `0001_initial_schema.ts`; adding new ones is a migration.

## What the numbers mean in practice

We deliberately ship with a small set of indices and a brute-force vector path because the alternative — an ANN backend, more covering indices, lazy materialised views — buys complexity now in exchange for a problem most users will not have. The break-even points above are the contract: when a user reports falling below them, we add the necessary structure, never speculatively.

The two operations whose cost grows linearly with the store are:

- **Vector search** when `retrieval.vector.enabled = true`. See [KNOWN_LIMITATIONS.md](../../KNOWN_LIMITATIONS.md) for the brute-force backend's degradation profile. The swap-out (a native ANN) is config-driven (`retrieval.vector.backend = auto`) and additive — existing stores keep working.
- **`embedding.rebuild`**, by definition. It is invoked only on model migration and is intentionally explicit (Rule 14).

Every other read path is logarithmic in store size or independent of it.

## Where the cost lives, by phase

Per write:

1. One row insert into `memories` (B-tree).
2. FTS5 trigger updates the inverted index transactionally.
3. Audit row for the verb (`memory.write`).
4. If the write commit succeeds and `embedding.autoEmbed` is true, one fire-and-forget embedder call via the `afterWrite` hook. This does not block the write response; transient failures are swallowed and the embedding is materialised later by `embedding.rebuild`.

Per read (search):

1. Scope filter — index probe on `scope_type` + scope columns.
2. Candidate generation — FTS5 match (always); vector brute-force scan (when enabled), unioned by ID.
3. Ranker — small, in-memory top-`k` heap over the candidate set.
4. Audit row for the verb (`memory.search`).

The conflict-detection hook on writes ([conflict-detection.md](conflict-detection.md)) runs inside the `(scope, kind)` bucket only; it does not scan the whole store.

## What we do not do

- **No background indexer.** Writes update FTS5 inline and fire-and-forget the embedding via the `afterWrite` hook (when `embedding.autoEmbed` is true). The embedding is async so writes return immediately; search may lag behind for newly-written memories until the embed completes. `embedding.rebuild` backfills any that were missed.
- **No query plan cache.** SQLite plans are cheap to recompute and the workload is hot-row-dominated; a cache would be solving a problem we do not have.
- **No premature ANN.** The vector backend stays brute-force until `n_e` hits the documented break-even. Until then, an ANN's recall floor is a regression, not an improvement.

## Configuration knobs that change cost

Every entry in this table is in `docs/reference/config-keys.md`. We list them here only with their performance angle.

| Key                                     | What it changes                                                             |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `retrieval.vector.enabled`              | Enables the linear-cost vector path on search and the async embedder call on write (default: true) |
| `retrieval.vector.backend`              | `brute-force` is `O(n_e · d)`; `auto` will pick a native ANN when available |
| `retrieval.candidates.maxPerSource`     | Bounds `m` from each candidate source — caps ranker work                     |
| `retrieval.results.defaultPageSize`     | Bounds `k` for the top-`k` heap                                              |
| `safety.bulkDestructiveLimit`           | Caps the work of one bulk `forget_many` / `archive_many` call               |
| `embedder.local.model`                  | Changing it requires `memento embedding rebuild` (linear-cost reindex)      |

## How we verify the envelope

The numbers above are not theoretical. They sit on top of three things:

1. The data model itself: every documented operation maps to a small number of named SQL statements (or a single embedder call). The per-row work is auditable from the migrations and the repository code.
2. The unit and integration suites in `packages/core/test/` exercise each verb on a `:memory:` SQLite, so regressions in row-shape or index usage surface immediately.
3. The `KNOWN_LIMITATIONS.md` entry on the brute-force vector scan is the public commitment: if we change that, the doc and the limitations entry move together.

When a user reports a workload outside this envelope, the fix is one of: add an index (migration), switch a backend (config), or batch a long-running operation (code). In every case, the change is additive and the existing operation keeps working at the documented cost.
