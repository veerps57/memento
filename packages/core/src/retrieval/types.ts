// Retrieval types.
//
// Per `docs/architecture/retrieval.md` the pipeline is
//   query → scope filter → candidate generation → ranker → results
// and every stage is replaceable by configuration. The types
// below describe the surface the engine exposes; concrete
// implementations live in sibling modules.

import type {
  Memory,
  MemoryId,
  MemoryKindType,
  Scope,
  Timestamp,
} from '@psraghuveer/memento-schema';

/**
 * Caller-supplied query.
 *
 * - `text` is the search string. It is treated as a bag of
 *   tokens against FTS5; advanced FTS5 syntax is rejected at the
 *   ingest boundary (see `sanitizeFtsQuery` in `fts.ts`).
 * - `scopes`, when supplied, restricts results to memories whose
 *   `scope` equals any element. Pass the output of
 *   `resolveEffectiveScopes` to honour the layered read.
 * - `includeStatuses` defaults to `['active']`. Operators may
 *   widen for debugging; `superseded` rows are still excluded by
 *   default because they carry a non-null `supersededBy`.
 * - `kinds` narrows by memory kind.
 * - `limit` is clamped against `retrieval.search.maxLimit`; the
 *   default comes from `retrieval.search.defaultLimit`.
 * - `now` is the clock instant used for recency/decay scoring.
 *   Callers (typically the command layer) thread their clock
 *   through so tests are deterministic.
 */
export interface SearchQuery {
  readonly text: string;
  readonly scopes?: readonly Scope[];
  readonly includeStatuses?: readonly ('active' | 'superseded' | 'forgotten' | 'archived')[];
  readonly kinds?: readonly MemoryKindType[];
  readonly limit?: number;
  readonly now?: Timestamp;
  /**
   * Pagination cursor. When supplied, results start *after* the
   * memory with this id in the ranked output. Stable across
   * pages because the ranker is a pure function of the query +
   * memory state — reissuing the query yields the same order.
   * Stale cursors (id not present in the current ranked set, or
   * pointing past the last page) yield an empty page.
   */
  readonly cursor?: MemoryId;
}

/**
 * Per-component scores for a ranked candidate. Surfaced so
 * callers can debug ranker behaviour and so the contract test
 * for the linear ranker can assert weighted composition.
 *
 * Components are normalised before weighting:
 *
 *   - `fts`: max-normalised BM25 across the candidate batch
 *     (1 = most-relevant in batch, 0 = no FTS match). Negated
 *     because SQLite's `bm25()` returns lower-is-better.
 *   - `vector`: reserved; v1 always reports 0 because vector
 *     candidate generation is gated behind
 *     `retrieval.vector.enabled`.
 *   - `confidence`: `effectiveConfidence(memory, now)` per
 *     `docs/architecture/decay-and-supersession.md`. Already in
 *     `[0,1]`.
 *   - `recency`: `0.5 ^ ((now - lastConfirmedAt) / halfLife)`,
 *     `0` when `retrieval.recency.halfLife` is `0`.
 *   - `scope`: scope-specificity boost in `[0,1]`. The
 *     most-specific scope in the supplied `scopes` array scores
 *     `1`, the least-specific scores `0`. When no `scopes` are
 *     supplied this component is `0`.
 *   - `pinned`: `1` when pinned, else `0`.
 */
export interface ScoreBreakdown {
  readonly fts: number;
  readonly vector: number;
  readonly confidence: number;
  readonly recency: number;
  readonly scope: number;
  readonly pinned: number;
}

/**
 * One ranked result. `score` is the linear combination of the
 * `breakdown` components weighted per `retrieval.ranker.weights.*`.
 */
export interface SearchResult {
  readonly memory: Memory;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}

/**
 * Page envelope returned by `searchMemories`. `nextCursor` is
 * the id of the last result in this page when more pages
 * follow, otherwise `null`. Callers stop paginating when
 * `nextCursor === null`.
 */
export interface SearchPage {
  readonly results: SearchResult[];
  readonly nextCursor: MemoryId | null;
}

/**
 * Output of the candidate-generation stage. The pipeline
 * collapses FTS and (when enabled) vector candidates by
 * memory id before passing the union to the ranker.
 */
export interface RawCandidate {
  readonly id: MemoryId;
  /** SQLite `bm25()` score. Lower = better; `null` = no FTS match. */
  readonly bm25: number | null;
  /** Cosine similarity in `[-1, 1]`; `null` = no vector match (or vector disabled). */
  readonly cosine: number | null;
}
