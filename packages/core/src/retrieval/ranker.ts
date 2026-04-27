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
    const score =
      options.weights.fts * breakdown.fts +
      options.weights.vector * breakdown.vector +
      options.weights.confidence * breakdown.confidence +
      options.weights.recency * breakdown.recency +
      options.weights.scope * breakdown.scope +
      options.weights.pinned * breakdown.pinned;
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
