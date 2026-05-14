# Retrieval-quality eval

Memento ships a labeled retrieval-quality harness at [`scripts/retrieval-eval.mjs`](../../scripts/retrieval-eval.mjs). It measures `Recall@1` / `Recall@5` / `Recall@10`, MRR, nDCG@10, latency p50/p95/p99, and per-arm candidate-set sizes for a fixed set of labeled queries planted into a fresh in-memory SQLite, then writes a markdown report.

Run it before/after retrieval changes — new rankers, ranker-weight tweaks, candidate-arm changes, diversity passes — and diff the report against a recent baseline to see whether quality moved.

This is the sibling of [`stress-test.md`](stress-test.md). The two answer different questions:

- **stress-test** — "is the engine fast, correct, and stable at scale?" (throughput, latency, contract probes)
- **retrieval-eval** — "is the ranker returning the right memories?" (Recall, MRR, nDCG over a labeled set)

## Running it

The runner does **not** touch your real Memento database. Each invocation creates a fresh, timestamped test DB under `/tmp/memento-eval-<ts>-*.db` and writes the report at `./eval-report-<ts>.md` (in the directory you ran the command from). Override the report path with `--out`.

Build the engine and the embedder first (the harness imports from each package's `dist/`):

```bash
pnpm -F @psraghuveer/memento-schema -F @psraghuveer/memento-core -F @psraghuveer/memento-embedder-local build
```

Then run:

```bash
node scripts/retrieval-eval.mjs                        # default: N=100,1000 sweep
node scripts/retrieval-eval.mjs --full                 # adds N=10000
node scripts/retrieval-eval.mjs --n=100,1000,10000     # explicit sweep
node scripts/retrieval-eval.mjs --no-vector            # FTS-only — skips the embedder
node scripts/retrieval-eval.mjs --samples=5            # warmup runs per query (raises p95 confidence)
```

The terminal prints one progress line per `(N, vector)` cell and the report path at the end.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--n=<csv>` | `100,1000` | Corpus sizes to sweep. Each cell seeds N synthetic memories plus the 14 planted needles. |
| `--full` | off | Shorthand for `--n=100,1000,10000`. |
| `--samples=N` | `3` | Repeats per labeled query before reporting latency. Higher = tighter p95/p99. |
| `--no-vector` | off | Skip the vector arm entirely. Halves wall-clock and lets a pure-FTS regression isolate cleanly. |
| `--no-tokenizer` | off | Skip the real bge WordPiece token counter; fall back to a documented heuristic. Useful when the model isn't cached and you don't want to download it. |
| `--out=<path>` | `./eval-report-<ts>.md` | Report path. |
| `--strategy=<linear\|rrf>` | engine default | Override `retrieval.ranker.strategy` for the run. |
| `--fts-weight=<n>` | engine default | Override `retrieval.ranker.weights.fts`. |
| `--vector-weight=<n>` | engine default | Override `retrieval.ranker.weights.vector`. |
| `--rrf-k=<n>` | engine default | Override `retrieval.ranker.rrf.k` (only meaningful with `--strategy=rrf`). |
| `--lambda=<n>` | engine default | Override `context.diversity.lambda` (the MMR knob; `1.0` disables, smaller = more aggressive). |
| `--max-duplicates=<n>` | engine default | Override `context.diversity.maxDuplicates`. |
| `--fts-min-score=<n>` | engine default | Override `retrieval.candidate.ftsMinScore`. |
| `--vector-min-cosine=<n>` | engine default | Override `retrieval.candidate.vectorMinCosine`. |

The harness writes the resolved per-knob values into the report's `Environment` block so a future reader can diff a run by the one knob that changed.

## What it measures

Each cell is one `(N, vectorOn)` pair. The report has four blocks:

### 1. Headline summary

| Column | Meaning |
|---|---|
| Recall@1 / @5 / @10 | Fraction of labeled queries whose `relevant` needle appeared at top-K. |
| MRR | Mean Reciprocal Rank — `1 / rank_of_first_relevant`, averaged. |
| nDCG@10 | Position-discounted gain over the top-10. |
| p50 / p95 / p99 ms | Per-query latency after `samples` repeats. |
| Forbidden leaks | Count of queries where a `mustNotInclude` memory appeared in the top-K (supersession-bleed sentinel). `0/N` is the only good number. |
| Diversity hits | Count of queries whose `diversityTarget` showed up in the top-5 (only the `N-diversity` probe defines one). |

### 2. Per-axis recall

The same numbers broken out by labeled-query `axis` so a regression in (say) `forgotten-explicit` doesn't disappear into a healthy overall mean. Axes the harness currently probes:

| Axis | What it tests |
|---|---|
| `paraphrase-exact` (`B1-exact`) | Lexical hit on the planted fact. |
| `paraphrase-near` (`B2-paraphrase`) | Same fact phrased differently — vector arm has to carry it. |
| `paraphrase-implied` (`B3-implied`) | Implied reformulation — exercises the linear ranker's weighting. |
| `supersession-bleed` (`C-current-pref`) | The newer preference must rank above its superseded predecessor; the predecessor must NOT appear in top-K. |
| `temporal` (`D-temporal`) | Time-sensitive lookup against a 12-month spread (one of the harness's two "expected to be hard" probes today). |
| `cross-scope` (`E-cross-scope`) | A `repo`-scoped needle is reachable from a `global` query without scope flattening. |
| `diversity` (`N-diversity`) | A planted target survives near-duplicate crowding in the top-5. Sensitive to MMR. |
| `self-consistency` (`J-consistency`) | The same query returns the same top-K across repeats. |
| `adversarial` (`M-stopwords`) | Stopword-heavy query returns the planted anchor, not the noise. |
| `adversarial-anchor` (`M-anchor`) | A distinctive anchor word in the query lands the right memory regardless of surrounding noise. |
| `pinned-floor` (`P-pinned-floor`) | A pinned old memory stays above an unpinned recent one when the query is ambiguous. |
| `forgotten-default` (`F-forgotten-default`) | A forgotten memory is NOT returned with default `includeStatuses` (active-only). |
| `forgotten-explicit` (`F-forgotten-explicit`) | A forgotten memory IS returned when the caller opts in via `includeStatuses: ['forgotten']`. |

### 3. Latency, by query

The full per-(query, sample) latency series so a long-tail outlier in the headline p99 can be traced to a specific labeled query.

### 4. Selected top-5 traces

For a fixed subset of canonical queries (one per axis where useful), the report prints the actual top-5 memory ids + scores + score breakdowns. This is the right place to look when a Recall@1 number looks bad — see whether the right needle ranked at position 2, 3, or didn't show up at all.

## Adding a probe

1. Append a `NEEDLE_DEFS` entry — content, scope, kind, tags, pinned, sensitive, plus any `pinnedFloor` / temporal back-dating you need. The harness plants these as real memories via `executeCommand`.
2. Append a `LABELED_QUERIES` entry — `axis`, `text`, `relevant` (the set of needle ids you expect to appear in the top-K), `mustNotInclude` if applicable, `diversityTarget` if you want diversity scored.
3. Optionally add a row to the "Selected top-5 traces" block at the bottom of the script if you want top-5 explainability for the new probe.

Probes should be small, mechanical, and explainable — if a probe needs paragraphs of prose to motivate, it belongs in a separate harness.

## Interpreting numbers

Look at the columns in this order:

1. **`Forbidden leaks` ≠ 0/N.** Always a regression. Means a memory that should not have surfaced did. Inspect the top-5 trace for the failing query.
2. **Per-axis Recall@1 drop on a specific axis.** A whole-table drop is a global ranker problem; a single-axis drop points you at a specific code path (e.g. `forgotten-explicit` failing implicates the vector arm's status filter; `supersession-bleed` failing implicates the demotion multiplier).
3. **`p50` flat, `p95` / `p99` spiking.** A long-tail latency issue — usually a specific query hitting a corner case. The "Latency, by query" block isolates which.
4. **Overall Recall@1 flat, `Diversity hits` dropping.** MMR is off, mistuned, or operating on the wrong projection. Sanity-check `context.diversity.lambda`.

There is no threshold table baked in — unlike `stress-test.mjs`, the harness reports raw numbers and leaves the call to a human (or future CI gate) reading two reports side by side.

## What this doesn't cover

Out of scope for this harness, deliberately:

- **Reranking quality.** Memento doesn't ship a reranker; if one is added, it needs its own probes.
- **Multilingual queries.** The labeled set is English. Adding probes in other languages is straightforward but a separate effort.
- **Cross-machine variance.** Numbers are wall-clock on the running machine; compare across runs on the same hardware.
- **Real concurrency.** Single-process, like the stress test.
- **Production drift.** This is a synthetic corpus. A production-drift probe over a real (anonymised) dump is a separate harness.

If you need any of those, add a separate runner rather than bolting onto this one — see [`stress-test.md`](stress-test.md) for the same posture.

## Cleanup

Test DBs accumulate under `/tmp/`. Reports accumulate in whichever directory you run from. Both are safe to delete:

```bash
rm -f /tmp/memento-eval-*.db /tmp/memento-eval-*.db-shm /tmp/memento-eval-*.db-wal
rm -f ./eval-report-*.md
```
