# Stress test

Memento ships a single end-to-end stress-test runner at [`scripts/stress-test.mjs`](../../scripts/stress-test.mjs). It exercises correctness invariants, write throughput, search and list latency, recall, vector retrieval, and `compact.run` against a fresh test database, then writes a markdown report.

Run it before releases, after large architectural changes, or whenever you want a single-glance health check on the engine.

## Running it

The runner does **not** touch your real Memento database. Each invocation creates a fresh, timestamped test DB at `/tmp/memento-stress-test-<timestamp>.db` and writes a markdown report at `./memento-stress-<timestamp>.md` (in the directory you ran the command from). Both paths can be overridden with `--db` / `--out`.

A stress test is only meaningful on an empty database, so there is no `--reuse` mode — every run starts from zero. Old test DBs in `/tmp/` accumulate across runs; delete them when you're done with `rm /tmp/memento-stress-test-*.db*`.

Build the engine first (the runner imports from `packages/core/dist/`):

```bash
pnpm -F @psraghuveer/memento-schema -F @psraghuveer/memento-core -F @psraghuveer/memento-embedder-local build
```

Then pick a mode:

```bash
node scripts/stress-test.mjs --mode=quick      # ~5s, 5k corpus
node scripts/stress-test.mjs                   # standard, ~30s, 50k corpus
node scripts/stress-test.mjs --mode=full       # ~3 min, 200k corpus
```

The terminal prints a one-block summary at the end. The full report lands in your current working directory at `./memento-stress-<timestamp>.md`. The path is shown on the last line of stdout.

### Modes

| Mode | Corpus | Vector subset | Search samples | Wall-clock (typical) |
|---|---|---|---|---|
| `quick` | 5,000 | 500 | 20 | ~5s |
| `standard` (default) | 50,000 | 2,000 | 50 | ~30s |
| `full` | 200,000 | 5,000 | 50 | ~3 min |

### Flags

| Flag | Env var | Default | Notes |
|---|---|---|---|
| `--mode=<quick\|standard\|full>` | `MEMENTO_STRESS_MODE` | `standard` | Picks a preset for the four knobs below. |
| `--target=N` | `MEMENTO_STRESS_TARGET` | mode-specific | Number of memories to seed. Overrides the mode preset. |
| `--vector-subset=N` | — | mode-specific | Number of memories to attach fake embeddings to for the vector-latency bench. |
| `--search-samples=N` | — | mode-specific | Number of search queries timed per snapshot. |
| `--db=<path>` | `MEMENTO_STRESS_DB` | `/tmp/memento-stress-test-<ts>.db` | Test DB path. Default is timestamped so each run uses a fresh file; if you pass an explicit path you take responsibility for it being empty. |
| `--out=<path>` | `MEMENTO_STRESS_OUT` | `./memento-stress-<ts>.md` | Where to write the markdown report. Default is the current working directory. |
| `--no-vector` | `MEMENTO_STRESS_NO_VECTOR=true` | off | Skip the vector phase entirely. Roughly halves wall-clock on `standard` and `full` runs. |

## What it measures

The runner emits four blocks in the report. Each row is annotated against a target threshold; ⚠ flags a regression worth investigating, ✅ means the value is within target.

### 1. Correctness suite

Pass/fail probes that exercise the engine's contracts and known-tricky surfaces. Each probe has a stable ID so reports diffed over time stay aligned. ⚠ rows mark a probe that didn't pass on this run — they're the most useful place to start when triaging a regression.

| ID | What it checks |
|---|---|
| `CONFLICT-pref-detection` | Conflict detection fires on a pair of opposing preferences sharing a `topic:` first line. |
| `EXTRACT-batch-dedup` | `extract_memory` deduplicates byte-identical candidates submitted in the same batch. |
| `EMBED-dim-mismatch` | `set_memory_embedding` rejects vectors whose model/dimension disagree with the configured embedder. |
| `SCR-jwt` / `SCR-aws` / `SCR-bearer` | Default scrubber rules catch JWTs, AWS access-key ids, and `Authorization: Bearer` headers. |
| `SCR-conn-string` | DB connection-string passwords are redacted, host preserved, and the redaction marker is appropriate (not mislabeled as `<email-redacted>`). |
| `SCR-mysql-host` | `mysql://` password is redacted even when the host has no FQDN suffix. |
| `SCR-underscore-name` | Compound secret names like `secret_token`, `access_token`, `aws_session_token` are caught. |
| `SCR-url-greedy` | URL `?secret=…` redaction stops at the secret value and does not eat trailing `&param=…` pairs. |
| `UPD-content` / `UPD-scope` | `update_memory` rejects `content` and `scope` patches with a pointer to `supersede`. |
| `SM-restore-active` / `SM-double-forget` | Illegal state transitions return `CONFLICT`. |
| `IDEM-clientToken` | Duplicate `(scope, clientToken)` writes return the existing memory's id. |
| `SCHEMA-content-empty` / `SCHEMA-tag-count` | Schema validation rejects empty content and >64 tags. |

To add a probe, append a new entry to the `makeCorrectnessTests()` array in `scripts/stress-test.mjs`. Each test is self-contained and returns `{ pass, expected, actual }`.

### 2. Performance snapshots

Taken at the configured corpus sizes (e.g. 10k, 50k, 100k, 200k for `--mode=full`). All numbers are wall-clock on the running machine.

| Section | Metric | What "good" looks like |
|---|---|---|
| Write throughput | avg writes/sec, DB size, bytes/memory | ≥5,000 writes/sec sustained. ~940 bytes/memory bare; ~4 KB with 768-d embeddings. |
| Search latency (FTS-only) | p50, p95, p99 over a fixed query bank | p50 ≤20 ms; p95 ≤50 ms; p99 ≤150 ms — at any corpus size. |
| `memory.list` | latency at limit=10, 100, 1000 | limit=10 ≤100 ms at any corpus. If this row trends linearly with corpus size you're seeing a missing-index regression — bench `EXPLAIN QUERY PLAN` against the dominant `memory.list` shape. |
| `get_memory_context` | p50, p95 | p50 ≤200 ms at any corpus. Linear scaling here means the ranker is fetching all active memories before the weighted sort; cap candidates with a top-N-by-recency materialization first. |
| Needle recall | top-1 / top-10 / rank for 5 planted needles | 5/5 top-1 across all snapshots. Recall regression = corpus tokenization / ranker bug. |

### 3. Scope filter & adversarial queries

| Section | What it surfaces |
|---|---|
| Scope filter speedup | Repo-scoped vs unfiltered list/search latency. The gap quantifies how much your indexes earn their keep. |
| Adversarial query patterns | p50/p95/p99 for short single chars, common stopwords (`the`, `is`, `and`), rare distinctive terms, multi-word queries, and no-match queries. Common-word p95 is the headline number — that's what natural-language assistants will hit. |

### 4. Vector + FTS hybrid + compact.run

| Section | What it surfaces |
|---|---|
| Vector + FTS hybrid | p50/p95/p99 for `rare` and `multi` query classes with `retrieval.vector.enabled: true`. Dominated by query-embedding wall-clock on CPU (≈300 ms per query for `bge-base-en-v1.5`). |
| Vector recall on needle N1 | The needle is embedded with the real provider; rank should be 1. |
| `compact.run` | Wall-clock, scanned, archived for one batch. The runner reports a single batch; full-corpus compaction may need multiple invocations depending on `compact.run.defaultBatchSize`. |

## Threshold defaults

The runner's `THRESHOLDS` constant defines the warning levels. They're tuned for an Apple-silicon laptop running locally; bump them if you're on slower hardware.

| Threshold | Default | What it gates |
|---|---|---|
| `writeThroughput` | ≥5,000 writes/sec | Sustained `writeMany` rate. |
| `searchFtsP50` | ≤20 ms | FTS-only search p50, any corpus. |
| `searchFtsP95` | ≤50 ms | FTS-only search p95. |
| `searchFtsP99` | ≤150 ms | FTS-only search p99. |
| `listLimit10` | ≤100 ms | `memory.list({limit: 10})` at any corpus. |
| `listLimit100` | ≤200 ms | Same, limit=100. |
| `listLimit1000` | ≤400 ms | Same, limit=1000. |
| `contextP50` | ≤200 ms | `get_memory_context` p50. |
| `contextP95` | ≤300 ms | `get_memory_context` p95. |
| `vectorSearchP50` | ≤600 ms | Vector + FTS hybrid p50. Dominated by CPU embedding latency. |
| `vectorSearchP95` | ≤1,000 ms | Vector + FTS hybrid p95. |
| `compactBatchMs` | ≤2,000 ms | One `compact.run` batch on the seeded corpus. |

To adjust, edit the `THRESHOLDS` object near the top of `scripts/stress-test.mjs`. Defaults should evolve as the engine improves.

## Interpreting failures

A row turns ⚠ when:

- **A correctness probe fails.** The `Expected` and `Actual` columns explain why. Each probe is independent — a fail here means the engine's contract is violated, not the runner.
- **A performance metric exceeds its threshold.** The summary line lists which suite + which metric. Re-run with `--mode=full` to confirm the regression isn't a small-corpus artefact, then bisect.
- **Needle recall drops below 5/5.** Either the FTS tokenizer changed, the ranker changed, or the seeded corpus inadvertently overlaps with needle vocabulary. Inspect the needle definitions in `scripts/stress-test.mjs` and the `QUERY_BANK` for collisions.

The report's `Reproduction` section at the bottom is a one-liner that re-runs the exact same configuration.

## Comparing runs over time

The report is plain markdown. Diff two reports with `diff` or your editor's diff view:

```bash
diff ./memento-stress-<earlier-timestamp>.md ./memento-stress-<later-timestamp>.md
```

For longer-term tracking, archive reports under a directory of your choice (the runner doesn't do this — by design, it's stateless). A tiny wrapper that copies the report to `~/.memento-stress-history/` is straightforward to add.

## What the runner does NOT cover

These are deliberately out of scope:

- **Real concurrency.** The runner is single-process. SQLite WAL contention under multiple-process load is not exercised.
- **Cross-platform variance.** Numbers on Linux / Windows differ, sometimes a lot. Native module behaviour around `better-sqlite3` is the dominant source of variation.
- **Import / export round-trip.** Snapshot integrity belongs in its own dedicated test.
- **Migration safety.** Old CLI against newer DB, mid-migration interrupt, embedder model change after seed.
- **Dashboard UI.** Visual smoke under a large corpus.

If you need any of those covered, add a separate runner — don't bolt them onto this one.

## Cleanup

Test DBs accumulate under `/tmp/`. Reports accumulate in whichever directory you run from. Both are safe to delete at any time:

```bash
# Delete all test DBs (safe — they're throwaway, not your real Memento DB)
rm -f /tmp/memento-stress-test-*.db /tmp/memento-stress-test-*.db-shm /tmp/memento-stress-test-*.db-wal

# Delete reports in the current directory
rm -f ./memento-stress-*.md
```

The runner writes test DBs under `/tmp/` and reports in `pwd`. It does not write anywhere else.
