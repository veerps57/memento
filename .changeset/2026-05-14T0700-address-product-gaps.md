---
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-schema': minor
'@psraghuveer/memento-embedder-local': minor
'@psraghuveer/memento': patch
---

Close the retrieval-quality and write-safety gaps surfaced by the 2026-05-11 evaluation cycle.

The branch ships twelve coordinated changes. The headline is retrieval quality: against the same harness (`--n=100,1000 --samples=5`), overall `Recall@1` at N=1000 with vector retrieval enabled moves from **83.6% → 92.7%**, MRR from `0.875 → 0.917`, nDCG@10 from `0.886 → 0.917`. The full +9.1 pp lift is attributable to one structural fix — forgotten/archived rows can now carry embeddings — but the rest of the branch is the foundation that makes the next round of retrieval work cheap: opt-in ranker variants, candidate-arm controls, diversity, projection, write-time guards, batched lookups, and a boot-time warmup hook so the first user-facing query no longer pays the model-init cost.

**Retrieval pipeline.**

- **Temporal filters on `memory.search` and `memory.events`.** New optional `createdAtAfter` / `createdAtBefore` (search), `confirmedAfter` / `confirmedBefore` (search), and `since` / `until` (events) input fields, all half-open against the relevant timestamp.
- **Per-arm candidate thresholds.** New `retrieval.candidate.ftsMinScore` (compares against `|BM25|`, default `0`) and `retrieval.candidate.vectorMinCosine` (default `-1`). Defaults are no-op; flipping them gives operators a small p95 latency win at no cost to recall on the eval corpus (p95 dropped from 184 ms → 161 ms at N=1000 vector-on when both thresholds were raised to `0.65`).
- **RRF ranker strategy.** New `retrieval.ranker.strategy: 'linear' | 'rrf'` (default `linear`) and `retrieval.ranker.rrf.k` (default `60`). Reciprocal Rank Fusion over the FTS and vector arms; the four baseline arms (confidence, recency, scope, pinned) compose on top exactly as in the linear ranker. RRF is opt-in because at the shipped weights it under-performs linear on this harness (Recall@1 N=1000 vec-on `92.7% → 65.5%`); the strategy is there for hosts that want to tune weights for their own corpus.
- **MMR diversity post-rank pass.** New `applyMMR` helper in `@psraghuveer/memento-core/retrieval/diversity`, wired into `memory.context` by default (`context.diversity.lambda: 0.7`) and opt-in on `memory.search`. Windowed implementation: the pass runs over the top `limit * 2` head and splices the unmodified tail back, so the latency cost stays bounded. Effect lives in `memory.context`'s top-5 (the survey-style retrieval surface), not in `memory.search` (the lookup surface), and the harness reflects that — search-probe metrics are identical with MMR on vs off.
- **Supersession demotion when successor co-present.** New `retrieval.ranker.weights.supersedingMultiplier` (default `0.5`, mutable). Multiplies a superseded memory's score when the successor is in the same result set; only fires when callers opt into superseded retrieval via `includeStatuses`. Default `memory.search` (active-only) is unchanged.
- **Allow embedding of forgotten / archived rows.** `memory.set_embedding` now accepts the three reachable statuses; `embedding.rebuild` accepts a new optional `includeNonActive: boolean` (CLI: `--include-non-active`) to extend its scan beyond active. **This is the structural fix that moves the headline metric.** With it, the `F-forgotten-explicit` probe's `Recall@1` recovers from `0.0% → 100.0%`, lifting the overall composite.

**Write-time safety.**

- **Topic-line validation for `preference` and `decision` writes.** New `safety.requireTopicLine` config key (`z.boolean()`, **default `true`**, mutable). `memory.write`, `memory.write_many`, `memory.supersede`, and `memory.extract` reject `preference` / `decision` content whose first non-blank line does not parse as `topic: value` (or `topic = value`). The validator reuses the parser the conflict detector already uses, so write-time gating and retrieval-time conflict detection stay in sync: content that would silently bypass the detector now fails fast at write time with a pointer to the canonical example. Flip the flag to `false` to keep the historical permissive shape.

**Diagnostics.**

- **Projection mode on `memory.search`.** New `projection: 'full' | 'summary'` input. **Default is `summary`**, which drops the `breakdown` and `conflicts` per-result objects from the wire shape — typical top-10 payload shrinks by ~30–40% with no loss of the memory body. Callers needing ranking explainability pass `projection: 'full'`. The schema fields stay optional rather than splitting into a union, so existing consumers see the same TS surface.
- **Near-uniform-ranking hint on `memory.context`.** New `context.hint.uniformSpreadThreshold` (default `0.05`). When the top-K scores cluster within the threshold, the response includes a `hint: 'near-uniform'` diagnostic so callers (or downstream agents) can tell apart "we found one strong match" from "we found ten ambiguous matches."

**Performance.**

- **Batched open-conflict lookup in `memory.search`.** When `conflict.surfaceInSearch` is enabled, conflict annotation now issues one `listOpenByMemoryIds` round-trip for the whole page instead of N per-result `list` calls. New `ConflictRepository.listOpenByMemoryIds(ids): ReadonlyMap<string, Conflict[]>` method on the public interface.
- **Optional embedder warmup at boot.** New optional `warmup?: () => Promise<void>` on the `EmbeddingProvider` interface; `@psraghuveer/memento-embedder-local` implements it by driving its single-flight init. New `embedder.local.warmupOnBoot` config key (`z.boolean()`, default `true`). Bootstrap fires the warmup fire-and-forget after the startup backfill, so the first user-facing query no longer pays the lazy-init cost. Failures are swallowed; the next real `embed()` call surfaces any underlying error.

**Public API additions.**

- New input fields on `MemorySearchInputSchema` and `MemoryEventsInputSchema` (temporal filters; `projection`).
- New optional input field `includeNonActive` on `EmbeddingRebuildInputSchema`.
- New named exports from `@psraghuveer/memento-core`: `applyMMR` (and types), `rankRRF`, `parseKeyValue` (re-export from conflict module).
- New method on `ConflictRepository`: `listOpenByMemoryIds`.
- New optional method on `EmbeddingProvider`: `warmup`.
- New config keys: `retrieval.candidate.ftsMinScore`, `retrieval.candidate.vectorMinCosine`, `retrieval.ranker.strategy`, `retrieval.ranker.rrf.k`, `retrieval.ranker.weights.supersedingMultiplier`, `context.diversity.lambda`, `context.diversity.maxDuplicates`, `retrieval.diversity.lambda`, `retrieval.diversity.maxDuplicates`, `context.hint.uniformSpreadThreshold`, `safety.requireTopicLine`, `embedder.local.warmupOnBoot`.

**Behaviour changes.**

- `memory.search` projection defaults to `'summary'` — smaller wire payload by default. Pass `projection: 'full'` to restore the per-result `breakdown` and `conflicts` fields.
- `safety.requireTopicLine` defaults to `true`. Existing free-prose `preference` / `decision` writes will be rejected with `INVALID_INPUT` and a pointer to the `topic: value` example until the content is reshaped — or the flag is flipped to `false`.
- `memory.context` applies MMR diversity at `λ = 0.7` by default. Pass through or override `context.diversity.lambda` to disable (`1.0`) or strengthen (`< 0.7`).

**Out of scope.**

- Resolver-state surface on `system.info` / `system.list_scopes` (P2-2 / P2-3). Held pending the resolver subsystem the host wires; the bootstrap does not yet construct a typed `ActiveScopes`. Will land as a follow-up.
- Materialised `confirm_count` cache (P2-7). Architectural decision class — schema migration plus repo-write coordination plus doctor check is more than one decision and belongs behind a design proposal.
- Cloud embedders, LLM-driven conflict detection, multi-user surfaces. Unchanged from prior posture.
