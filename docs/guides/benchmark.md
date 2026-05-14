# End-to-end benchmark (memorybench)

Memento ships a driver at [`scripts/bench.mjs`](../../scripts/bench.mjs) that runs the public [`supermemoryai/memorybench`](https://github.com/supermemoryai/memorybench) harness end to end against a locally built Memento. Datasets, retrieval workflow, answering model, and LLM judge all come from memorybench — Memento contributes only the `MementoProvider` implementation under `src/providers/memento/`, proposed to memorybench upstream as a PR. Until that PR merges, point `--memorybench-dir` at a local checkout of the PR branch.

This is one of three measurement scripts; each answers a different question:

- [`stress-test.md`](stress-test.md) — *is the engine fast, correct, stable at scale?* (throughput, latency, contract probes)
- [`retrieval-eval.md`](retrieval-eval.md) — *is the ranker returning the right memories?* (Recall, MRR, nDCG over a small labeled needle set)
- `bench.mjs` (this guide) — *how does Memento answer real long-conversation questions?* (LoCoMo + LongMemEval, judged by an LLM)

`bench.mjs` is not part of `pnpm verify`. It needs network access, judge API keys, and hours of wall-clock; CI gates must pass offline.

## How the provider uses Memento

Memento stores **distilled assertions, not transcripts** — the calling AI assistant uses its own LLM to decide what's worth remembering, then hands those candidates to Memento's `extract_memory` MCP tool. The bench provider mirrors that flow inside the harness: for each `UnifiedSession` produced by memorybench, the provider calls the configured LLM (defaults to the bench's answering model) to produce structured `{kind, content}` candidates and writes them via `extract_memory`. Memento embeds, scrubs, dedups, and persists. The provider does no raw-message ingestion — the LLM-distillation step is what represents real Memento usage faithfully.

## Running it

Prereqs: [Bun](https://bun.sh) (`bun --version` >= 1.0), Node 22+, and the `ANTHROPIC_API_KEY` env var (the default judge / answering / distillation model is `sonnet-4.6`, because that's what the bulk of MCP-using clients run on the conversation side). For other model families, set the corresponding key (`GOOGLE_API_KEY` / `OPENAI_API_KEY`). The script builds Memento itself.

If your shell sets `ANTHROPIC_BASE_URL` (some agent runtimes do), ensure it ends in `/v1` — the AI SDK appends `/messages` to whatever you give it, so a bare `https://api.anthropic.com` produces a 404. Either unset the variable or point it at `https://api.anthropic.com/v1`.

```bash
export ANTHROPIC_API_KEY=...
node scripts/bench.mjs                                 # LoCoMo + LongMemEval, defaults (sonnet-4.6)
node scripts/bench.mjs --benchmark=locomo --limit=5    # 5-question smoke test
node scripts/bench.mjs --judge=gemini-2.5-pro          # cross-family judge (needs GOOGLE_API_KEY)
node scripts/bench.mjs --concurrency-ingest=1          # serialize ingest to stay under Anthropic rate limits
```

A summary markdown is written to `bench/<ts>.md` (one file per invocation, the directory is git-ignored); full per-question JSON reports live under the staged memorybench checkout at `data/runs/<runId>/report.json`. If a run crashes mid-flight (Anthropic `Overloaded`, network drop, Ctrl-C, OOM) the orchestrator persists a checkpoint after every phase boundary — re-run with `node scripts/bench.mjs --resume=<runId>` to pick up at the failed phase of the failed question, skipping all completed work. The runId is logged on a dedicated line in the bench log and printed again as a copy-pasteable command if the run exits non-zero.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--benchmark=<csv>` | `locomo,longmemeval` | Which benchmarks to run. Memorybench also has `convomem` (deferred). |
| `--judge=<model>` | `sonnet-4.6` | Model that scores `correct`/`incorrect`. Use a different family (e.g. `gemini-2.5-pro`) for cross-family-independence. |
| `--answering-model=<model>` | `sonnet-4.6` | Model that generates the hypothesis and (by default) the per-session distillation. |
| `--search-limit=<n>` | `30` | top-K returned by the provider. Passed through as `MEMENTO_BENCH_SEARCH_LIMIT`. |
| `--limit=<n>` | *(none)* | Cap questions per benchmark. Use for smoke tests. |
| `--memorybench-ref=<sha\|branch>` | `add-memento-provider` | Git ref of the fork to clone. |
| `--memorybench-dir=<path>` | *(none)* | Use a local fork checkout instead of cloning. Skips network. |
| `--memorybench-repo=<url>` | *(see DEFAULTS)* | Override the fork URL. |
| `--concurrency-ingest=<n>` | *(memorybench default)* | Lower to tame the embedder during ingest. `--concurrency-{indexing,search,answer,evaluate}` also accepted. |
| `--out=<path>` | `<mementoRoot>/bench` | Directory the summary `<ts>.md` is written into. |
| `--resume=<runId>` | *(none)* | Resume a crashed run by its runId (`memento-<bench>-<ts>`). Reuses the checkpoint at `<memorybench-dir>/data/runs/<runId>/checkpoint.json` and skips all completed phases. |

### Env vars

| Var | When | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` | Required for the chosen judge / answering family (the default needs `ANTHROPIC_API_KEY`). | Memorybench's judge + answering layer, and the provider's distillation step. |
| `ANTHROPIC_BASE_URL` | Optional override; must end in `/v1` if set. | The AI SDK appends `/messages`, so a bare domain produces 404s. |
| `MEMENTO_DISTILL_MODEL` | Optional | Override which model does session-level distillation (default: the answering model). |
| `MEMORYBENCH_REPO` / `MEMORYBENCH_REF` | Optional | Override default fork URL and ref. |
| `MEMORYBENCH_DIR` | Optional | Same as `--memorybench-dir`. |
| `MEMENTO_BENCH_KEEP_WORKDIR` | `1` to keep | Skip cleanup of the cloned fork dir at the end of a run. |

## What's measured

Memorybench reports per benchmark:

| Metric | Meaning |
|---|---|
| `accuracy` | `correctCount / totalQuestions` (judge labeling). |
| `MemScore` | Composite `${qualityPct}% / ${avgLatencyMs}ms / ${avgContextTokens}tok` — three numbers, never collapsed into one. |
| `latency.{ingest,indexing,search,answer,evaluate}` | Per-phase percentiles (p50/p95/p99). The search number is what gets surfaced in MemScore. |
| `tokens.avgContextTokens` | Average tokens of retrieved context the answering model received per question. |
| `byQuestionType` | Accuracy + latency broken out by the dataset's native question-type taxonomy. |

The summary file produced by `bench.mjs` extracts the headline + per-type table into one place. The raw `report.json` carries the full `evaluations` array if you need to trace a single question.

## How Memento exercises memorybench

`MementoProvider` implements memorybench's five-method `Provider` interface:

1. **`initialize`** spawns `memento serve --db <tmp>` over stdio, asserts the required MCP tools (`extract_memory`, `search_memory`, `forget_many_memories`) are present, and runs one warmup write so the bge-base-en-v1.5 embedder model is loaded before the first benchmark question.
2. **`ingest`** distills each `UnifiedSession` through the configured LLM into `{kind, content}` candidates, then hands the batch to Memento's `extract_memory`. Memories land under `scope = {type: 'workspace', path: '/memorybench/<containerTag>'}` (workspace scope is the isolation primitive because Memento's `session.id` requires a ULID, while memorybench's `containerTag` is an arbitrary string). Each memory carries `benchmark:memorybench`, `session:<id>`, and (when present) `session-date:<iso>` tags.
3. **`awaitIndexing`** polls `search_memory` on the question's scope until every result has `embeddingStatus !== 'pending'` (or a configurable 180s deadline expires).
4. **`search`** runs `search_memory` with the question's scope filter, `projection: 'full'`, and `limit: options.limit ?? 30`.
5. **`clear`** filters `forget_many_memories` by scope. The orchestrator doesn't call this in normal runs — containers persist for the run's lifetime — but it's there for partial-rerun recovery.

The provider supplies a custom `answerPrompt` (`src/providers/memento/prompts.ts` in the fork) that presents each retrieved memory with its score, kind, and session date — the latter being the temporal anchor the LLM used during distillation. Default JSON-stringified context would hide this structure.

## Methodology and caveats

**One server per benchmark run.** Spawning a fresh `memento serve` per question (~2000 spawns across LoCoMo + LongMemEval) is expensive without buying any isolation that workspace scope doesn't already give. The single-DB approach mirrors how `scripts/retrieval-eval.mjs` plants thousands of needles in one in-memory SQLite.

**Container isolation via workspace scope.** Each question's memories land under `{type: 'workspace', path: '/memorybench/<containerTag>'}`. Memento's architectural rule that scope is immutable per memory makes this isolation contract reliable. Searches always pass the per-question scope; `clear` filters by it.

**Datasets are fetched at runtime.** LoCoMo from `raw.githubusercontent.com/snap-research/locomo`, LongMemEval from HuggingFace `xiaowu0162/longmemeval-cleaned`. The first run of each benchmark downloads and caches the JSON under the staged memorybench checkout. A move or removal of the upstream dataset breaks reproducibility — see the [risks](#risks) section.

**Judge model = answering model = distillation model.** The baseline pins all three to `sonnet-4.6` — the model class that actually shows up on the conversation side in real Memento usage (Claude Code, Cursor, Claude Desktop dominate the MCP-using-client population, and `extract_memory` is called from that same assistant). Using the same model for all three avoids one layer of cross-family bias but does collapse to a single family's strengths and weaknesses; the standard robustness move is to swap the judge to a different family (e.g. `--judge=gemini-2.5-pro` or `--judge=gpt-4o`) and report agreement rates. Override via `--judge` / `--answering-model` / `MEMENTO_DISTILL_MODEL`.

**Container-tag stability on resume.** Memorybench's orchestrator tracks `completedSessions` per question, so a resumed run skips already-ingested sessions; the provider doesn't need to dedup on the write path.

## How to reproduce

```bash
git clone https://github.com/veerps57/memento && cd memento
pnpm install
# Build is run automatically by bench.mjs; can be done up front for offline reuse:
# pnpm -F @psraghuveer/memento-schema -F @psraghuveer/memento-core -F @psraghuveer/memento-server -F @psraghuveer/memento -F @psraghuveer/memento-embedder-local build

export ANTHROPIC_API_KEY=...
node scripts/bench.mjs --memorybench-ref=<commit-from-published-results>
```

The summary's reproducibility footer captures the exact Memento + memorybench commits used so a re-run against the same SHAs is byte-comparable up to model nondeterminism and dataset-upstream drift.

## Baseline results

*(Populated by the follow-up PR after the first full LoCoMo + LongMemEval run lands. Until then, this section reads "pending".)*

## Risks

- **Dataset upstream availability.** LoCoMo and LongMemEval are fetched on first use; if either repository moves or is taken down mid-run, the affected benchmark fails. Mitigation: pin a fork commit that vendors the datasets, or re-run from a cached checkout (`--memorybench-dir`).
- **Embedder model cold-download.** bge-base-en-v1.5 is downloaded from HuggingFace on the first Memento write of a fresh install. The provider's warmup step pulls this download into `initialize()` so the first benchmark question doesn't pay the cost — but the warmup itself can fail under flaky network.
- **Distillation LLM rate limits.** Per-session distillation adds one LLM call per session × ~20 sessions per question × ~20 questions per benchmark = a few hundred extra calls. With the default `sonnet-4.6`, Anthropic returns `Overloaded` (HTTP 529) under bursty parallel load; memorybench retries three times then fails the question. `--concurrency-ingest=1` serializes the ingest path and also lets the provider's per-session distillation cache hit (questions that share sessions skip the redundant LLM call) — it's the safest knob for any Anthropic-family distill.
- **Judge API rate limits.** Anthropic / OpenAI / Google RPM caps can stall the `evaluate` phase. Use `--concurrency-evaluate=10` (or lower) to soften the rate at the cost of wall-clock.
- **`ANTHROPIC_BASE_URL` shadowing.** Some agent runtimes set `ANTHROPIC_BASE_URL=https://api.anthropic.com` (no `/v1`). The `@ai-sdk/anthropic` client appends `/messages` to that, producing a 404 that surfaces as a generic `Not Found` ingest failure. Either unset the variable or point it at `https://api.anthropic.com/v1` before running the bench.

## Out of scope / future

- ConvoMem as a third benchmark.
- Multi-judge runs (Sonnet + GPT-4o + Gemini agreement rates) for robustness against single-judge bias.
- GitHub Actions nightly bench against `main` with auto-issue on regression.
- Dashboard widget showing the latest baseline.
- Pinning the driver to `npx @psraghuveer/memento@<version>` after a stable release so external contributors don't need a pnpm monorepo to reproduce.
