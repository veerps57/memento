// Linear ranker.
//
// Per `docs/architecture/retrieval.md` the v1 strategy is a
// configurable linear combination:
//
//   score = w_fts        * normalize(ftsScore)
//         + w_vector     * normalize(vectorScore)
//         + w_confidence * effectiveConfidence
//         + w_recency    * recencyBoost(lastConfirmedAt, now)
//         + w_scope      * scopeBoost(scope, queryScope)
//         + w_pinned     * (pinned ? 1 : 0)
//
// The ranker is pure: same `(candidates, weights, options)`
// always yields the same ordering. That keeps the
// audit/replay story for retrieval tractable and lets us assert
// behaviour structurally in tests without mocking time.

import type { Memory, Scope, Timestamp } from '@psraghuveer/memento-schema';
import { effectiveConfidence } from '../decay/engine.js';
import type { DecayConfig } from '../decay/engine.js';
import { scopeKey } from '../scope/resolver.js';
import type { RawCandidate, ScoreBreakdown, SearchResult } from './types.js';

export interface RankerWeights {
  readonly fts: number;
  readonly vector: number;
  readonly confidence: number;
  readonly recency: number;
  readonly scope: number;
  readonly pinned: number;
}

export interface RankerOptions {
  /** Ranker weights. Each key maps 1:1 to `retrieval.ranker.weights.*`. */
  readonly weights: RankerWeights;
  /** Half-life of the recency boost in ms. `0` disables the boost regardless of weight. */
  readonly recencyHalfLifeMs: number;
  /** Per-level boost factor for the scope-specificity component. */
  readonly scopeBoostPerLevel: number;
  /**
   * Resolved layered scope set, ordered most-specific → least-specific
   * (the natural output of `resolveEffectiveScopes`). The most-specific
   * scope scores `1`, the least-specific `0`. When undefined or empty
   * the scope component is `0` for every candidate.
   */
  readonly scopes?: readonly Scope[];
  /** Wall-clock instant used for confidence + recency. */
  readonly now: Timestamp;
  /** Decay config used to compute `effectiveConfidence`. */
  readonly decayConfig: DecayConfig;
  /**
   * Reciprocal-rank fusion dampening constant. Only consulted by
   * {@link rankRRF}; ignored by {@link rankLinear}. Default `60`
   * is the literature convention (Cormack et al. 2009).
   */
  readonly rrfK?: number;
  /**
   * Multiplier applied to a superseded memory's final score when
   * its successor (the row at `supersededBy`) is co-present in
   * the same result set. `1.0` (or omitted) disables demotion;
   * `0.5` halves the score of the predecessor so the active head
   * ranks above it on otherwise-similar arms. Only fires when the
   * caller opts into `includeStatuses: ["active", "superseded"]`
   * — the default active-only filter excludes predecessors
   * upstream and this hook never runs.
   */
  readonly supersedingMultiplier?: number;
}

/**
 * Combine raw candidates with their hydrated `Memory` rows and
 * rank by the linear weighted sum. Candidates without a matching
 * memory (e.g. raced supersession between FTS and read) are
 * dropped silently — the alternative is leaking a half-baked
 * result with `null` content, which is worse for the caller.
 */
export function rankLinear(
  candidates: readonly RawCandidate[],
  memories: ReadonlyMap<string, Memory>,
  options: RankerOptions,
): SearchResult[] {
  if (candidates.length === 0) {
    return [];
  }

  const ftsMax = maxAbsBm25(candidates);
  const cosineMax = maxCosine(candidates);
  const scopeRank = buildScopeRank(options.scopes);
  const nowMs = Date.parse(options.now as unknown as string);
  if (Number.isNaN(nowMs)) {
    throw new Error('rankLinear: options.now is not a valid ISO timestamp');
  }

  const out: SearchResult[] = [];
  for (const cand of candidates) {
    const memory = memories.get(cand.id as unknown as string);
    if (memory === undefined) {
      continue;
    }
    const breakdown = computeBreakdown(memory, cand, {
      ftsMax,
      cosineMax,
      scopeRank,
      nowMs,
      now: options.now,
      decayConfig: options.decayConfig,
      recencyHalfLifeMs: options.recencyHalfLifeMs,
      scopeBoostPerLevel: options.scopeBoostPerLevel,
    });
    let score =
      options.weights.fts * breakdown.fts +
      options.weights.vector * breakdown.vector +
      options.weights.confidence * breakdown.confidence +
      options.weights.recency * breakdown.recency +
      options.weights.scope * breakdown.scope +
      options.weights.pinned * breakdown.pinned;
    score = applySupersessionDemotion(score, memory, memories, options.supersedingMultiplier);
    out.push({ memory, score, breakdown });
  }

  // Stable tie-break by id descending: ULIDs are lexicographic
  // by creation time, so newer memories win ties without a
  // separate clock read.
  out.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (b.memory.id as unknown as string) < (a.memory.id as unknown as string) ? -1 : 1;
  });
  return out;
}

interface ComputeContext {
  readonly ftsMax: number;
  readonly cosineMax: number;
  readonly scopeRank: ReadonlyMap<string, number>;
  readonly nowMs: number;
  readonly now: Timestamp;
  readonly decayConfig: DecayConfig;
  readonly recencyHalfLifeMs: number;
  readonly scopeBoostPerLevel: number;
}

function computeBreakdown(memory: Memory, cand: RawCandidate, ctx: ComputeContext): ScoreBreakdown {
  // FTS: SQLite returns lower-is-better. Normalise to [0,1] by
  // dividing by the most-negative score in the batch (so the
  // best hit becomes 1.0). When every candidate has bm25==0 we
  // bail out to 0 to avoid a divide-by-zero.
  let fts = 0;
  if (cand.bm25 !== null && ctx.ftsMax > 0) {
    fts = Math.abs(cand.bm25) / ctx.ftsMax;
  }

  // Vector: cosine similarity ∈ [-1,1]. Map to [0,1] via
  // (x+1)/2 then divide by the batch max so weights compose
  // with the other components on the same scale.
  let vector = 0;
  if (cand.cosine !== null && ctx.cosineMax > 0) {
    vector = (cand.cosine + 1) / 2 / ctx.cosineMax;
  }

  const confidence = effectiveConfidence(memory, ctx.now, ctx.decayConfig);

  let recency = 0;
  if (ctx.recencyHalfLifeMs > 0) {
    const lastMs = Date.parse(memory.lastConfirmedAt as unknown as string);
    if (!Number.isNaN(lastMs)) {
      const dt = Math.max(0, ctx.nowMs - lastMs);
      recency = 0.5 ** (dt / ctx.recencyHalfLifeMs);
    }
  }

  const rank = ctx.scopeRank.get(scopeKey(memory.scope));
  const scope =
    rank === undefined || ctx.scopeRank.size <= 1
      ? 0
      : (ctx.scopeRank.size - 1 - rank) * ctx.scopeBoostPerLevel;

  const pinned = memory.pinned ? 1 : 0;

  return { fts, vector, confidence, recency, scope, pinned };
}

/**
 * Reciprocal Rank Fusion ranker.
 *
 * Replaces the linear ranker's max-normalised FTS / cosine arms
 * with rank-based contributions: `1 / (k + rank_a(candidate))`
 * for each arm `a ∈ {fts, vector}`. The four baseline arms
 * (confidence, recency, scope, pinned) carry over unchanged from
 * the linear ranker — they already live in `[0, 1]` units that
 * compose with the inverse-rank scale at reasonable default
 * weights.
 *
 * Why RRF eliminates the linear-ranker pathology: linear divides
 * every FTS score by the batch maximum, so a single dominant hit
 * collapses every other FTS contribution toward zero. RRF assigns
 * positions instead of magnitudes — the strongest FTS hit gets
 * rank 1, the next gets rank 2, regardless of the absolute gap
 * between them. The result is more robust on paraphrase queries
 * where vector scores cluster tightly and one rare exact-phrase
 * match would otherwise swamp the rest of the page.
 *
 * Candidates that match only one arm contribute on that arm
 * alone; their other arm's inverse-rank term is `0`, so they
 * rank below dual-arm matches at any reasonable weighting.
 */
export function rankRRF(
  candidates: readonly RawCandidate[],
  memories: ReadonlyMap<string, Memory>,
  options: RankerOptions,
): SearchResult[] {
  if (candidates.length === 0) {
    return [];
  }

  const k = options.rrfK ?? 60;
  const scopeRank = buildScopeRank(options.scopes);
  const nowMs = Date.parse(options.now as unknown as string);
  if (Number.isNaN(nowMs)) {
    throw new Error('rankRRF: options.now is not a valid ISO timestamp');
  }

  // Per-arm rank tables. FTS rank: ascending BM25 (most-negative
  // first, matching the SQLite ordering). Vector rank: descending
  // cosine (highest first). Candidates that did not match an arm
  // simply do not appear in that arm's map → inverse-rank 0.
  const ftsRank = new Map<string, number>();
  const ftsHits = candidates
    .filter((c) => c.bm25 !== null)
    .sort((a, b) => (a.bm25 as number) - (b.bm25 as number));
  ftsHits.forEach((c, i) => ftsRank.set(c.id as unknown as string, i + 1));

  const vectorRank = new Map<string, number>();
  const vectorHits = candidates
    .filter((c) => c.cosine !== null)
    .sort((a, b) => (b.cosine as number) - (a.cosine as number));
  vectorHits.forEach((c, i) => vectorRank.set(c.id as unknown as string, i + 1));

  const out: SearchResult[] = [];
  for (const cand of candidates) {
    const memory = memories.get(cand.id as unknown as string);
    if (memory === undefined) {
      continue;
    }
    const candId = cand.id as unknown as string;
    const ftsRk = ftsRank.get(candId);
    const vecRk = vectorRank.get(candId);
    const fts = ftsRk !== undefined ? 1 / (k + ftsRk) : 0;
    const vector = vecRk !== undefined ? 1 / (k + vecRk) : 0;

    // Baseline arms identical to the linear ranker. Kept inline
    // (not extracted) so each ranker is readable end-to-end and
    // future strategies can deviate from the baselines without
    // a four-arrow refactor cascade.
    const confidence = effectiveConfidence(memory, options.now, options.decayConfig);

    let recency = 0;
    if (options.recencyHalfLifeMs > 0) {
      const lastMs = Date.parse(memory.lastConfirmedAt as unknown as string);
      if (!Number.isNaN(lastMs)) {
        const dt = Math.max(0, nowMs - lastMs);
        recency = 0.5 ** (dt / options.recencyHalfLifeMs);
      }
    }

    const rank = scopeRank.get(scopeKey(memory.scope));
    const scope =
      rank === undefined || scopeRank.size <= 1
        ? 0
        : (scopeRank.size - 1 - rank) * options.scopeBoostPerLevel;

    const pinned = memory.pinned ? 1 : 0;

    const breakdown: ScoreBreakdown = { fts, vector, confidence, recency, scope, pinned };
    let score =
      options.weights.fts * fts +
      options.weights.vector * vector +
      options.weights.confidence * confidence +
      options.weights.recency * recency +
      options.weights.scope * scope +
      options.weights.pinned * pinned;
    score = applySupersessionDemotion(score, memory, memories, options.supersedingMultiplier);
    out.push({ memory, score, breakdown });
  }

  // Same stable tie-break as the linear ranker: descending score,
  // then descending id (newer ULIDs win ties).
  out.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (b.memory.id as unknown as string) < (a.memory.id as unknown as string) ? -1 : 1;
  });
  return out;
}

function maxAbsBm25(candidates: readonly RawCandidate[]): number {
  let max = 0;
  for (const c of candidates) {
    if (c.bm25 !== null) {
      const v = Math.abs(c.bm25);
      if (v > max) max = v;
    }
  }
  return max;
}

function maxCosine(candidates: readonly RawCandidate[]): number {
  let max = 0;
  for (const c of candidates) {
    if (c.cosine !== null) {
      const v = (c.cosine + 1) / 2;
      if (v > max) max = v;
    }
  }
  return max;
}

/**
 * Apply the superseded-predecessor demotion. Only fires when the
 * candidate is itself a superseded memory AND its `supersededBy`
 * pointer resolves to a memory in the current result set. This
 * keeps the demotion local to "the user asked for both sides of
 * a chain and we surfaced both" — a caller fetching the
 * predecessor in isolation (audit log, `memory.read` chains) is
 * unaffected because the successor isn't in `memories`.
 *
 * Shared between {@link rankLinear} and {@link rankRRF} so the
 * two rankers honour the same chain-demotion semantics.
 */
function applySupersessionDemotion(
  score: number,
  memory: Memory,
  memories: ReadonlyMap<string, Memory>,
  multiplier: number | undefined,
): number {
  if (multiplier === undefined || multiplier >= 1) {
    return score;
  }
  if (memory.status !== 'superseded') {
    return score;
  }
  if (memory.supersededBy === null) {
    return score;
  }
  if (!memories.has(memory.supersededBy as unknown as string)) {
    return score;
  }
  return score * multiplier;
}

function buildScopeRank(scopes: readonly Scope[] | undefined): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  if (scopes === undefined) {
    return map;
  }
  scopes.forEach((scope, idx) => {
    map.set(scopeKey(scope), idx);
  });
  return map;
}
