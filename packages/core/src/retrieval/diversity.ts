// Post-rank diversity pass via Maximal Marginal Relevance (MMR).
//
// Reorders the ranked output so successive picks penalise
// candidates similar to ones already chosen. At `lambda = 1` the
// function is a passthrough — no candidate's score is changed
// and the input order is preserved. At `lambda = 0` selection is
// pure diversity, ignoring relevance.
//
// MMR is applied *after* the ranker, not inside it. The two have
// independent contracts:
//   - The ranker assigns a scalar relevance score per candidate.
//   - The diversity pass reorders the scored list to break
//     near-duplicate clusters in the top-K.
//
// Why post-rank rather than as a ranker arm: MMR's selection is
// greedy and stateful (each pick depends on what came before),
// while the linear / rrf rankers are pure functions over the
// candidate set. Keeping the two stages separate preserves the
// linear ranker's purity (and its replay/audit story) and keeps
// the MMR cost proportional to the page size rather than the
// candidate-set size.
//
// Pairwise similarity uses cosine over the candidate vectors
// already threaded forward from the vector arm. Rows without an
// embedding (FTS-only candidates, pending-embed rows) bypass the
// diversity penalty — graceful degrade rather than synthetic
// punishment.

import type { Memory } from '@psraghuveer/memento-schema';
import { cosineSimilarity } from './vector.js';

export interface MMROptions {
  /**
   * MMR trade-off in `[0, 1]`. `1` is a passthrough (input order
   * preserved; no reordering). `0` is pure diversity. Default
   * `1` matches the registry default for `retrieval.diversity.lambda`.
   */
  readonly lambda: number;
  /**
   * Soft cap on the number of near-duplicate (cosine ≥ 0.9)
   * picks the pass admits before skipping further duplicates.
   * Composes with `lambda` — `lambda` controls the per-pick
   * reorder weight, `maxDuplicates` puts a hard cap on the
   * cluster size. Matches `retrieval.diversity.maxDuplicates`.
   */
  readonly maxDuplicates: number;
}

/**
 * Minimal shape `applyMMR` requires from its input. Both
 * `SearchResult` (the search pipeline) and `RankedContextResult`
 * (the context command) structurally satisfy this — they each
 * carry a `memory` with an `id` and a numeric `score`. The
 * generic constraint lets the same MMR primitive serve both
 * surfaces without an adapter layer.
 */
export interface MMRItem {
  readonly memory: Pick<Memory, 'id'>;
  readonly score: number;
}

const NEAR_DUPLICATE_COSINE = 0.9;

/**
 * Reorder `ranked` greedily by MMR. The input is treated as
 * already-sorted by relevance — the top entry remains the first
 * pick regardless of `lambda` (it has no predecessors to be
 * similar to). Each subsequent pick is selected to maximise:
 *
 *   λ × score - (1 - λ) × max(cosine_to_already_picked)
 *
 * `vectorById` carries the embedding for every candidate that
 * has one; absent entries are treated as "no vector → no
 * similarity penalty", so FTS-only / pending-embed rows ride
 * their relevance score alone. Callers build this map from
 * whichever source has the vectors on hand (the search pipeline
 * has them on `RawCandidate`; the context command reads
 * `memory.embedding?.vector`).
 *
 * The function is a passthrough when `lambda >= 1`; callers
 * gate the call on `lambda < 1` to skip the no-op.
 */
export function applyMMR<T extends MMRItem>(
  ranked: readonly T[],
  vectorById: ReadonlyMap<string, readonly number[]>,
  options: MMROptions,
): T[] {
  if (ranked.length <= 1) {
    return [...ranked];
  }
  if (options.lambda >= 1) {
    return [...ranked];
  }

  const remaining = [...ranked];
  const picked: T[] = [];
  const pickedVectors: (readonly number[] | null)[] = [];
  let nearDuplicates = 0;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i];
      if (cand === undefined) continue;
      const candVector = vectorById.get(cand.memory.id as unknown as string) ?? null;
      let maxSim = 0;
      if (candVector !== null) {
        for (const pv of pickedVectors) {
          if (pv === null) continue;
          const s = cosineSimilarity(candVector, pv);
          if (s > maxSim) maxSim = s;
        }
      }
      const mmr = options.lambda * cand.score - (1 - options.lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    const winner = remaining[bestIdx];
    if (winner === undefined) break;
    const winnerVector = vectorById.get(winner.memory.id as unknown as string) ?? null;

    // Enforce maxDuplicates: once the page already holds the
    // configured number of near-duplicates of any previous pick,
    // skip this candidate if it would extend that cluster.
    if (winnerVector !== null && pickedVectors.length > 0) {
      let isNear = false;
      for (const pv of pickedVectors) {
        if (pv === null) continue;
        if (cosineSimilarity(winnerVector, pv) >= NEAR_DUPLICATE_COSINE) {
          isNear = true;
          break;
        }
      }
      if (isNear && nearDuplicates >= options.maxDuplicates) {
        // Pop this candidate without picking it — try the next.
        remaining.splice(bestIdx, 1);
        continue;
      }
      if (isNear) {
        nearDuplicates += 1;
      }
    }

    picked.push(winner);
    pickedVectors.push(winnerVector);
    remaining.splice(bestIdx, 1);
  }

  return picked;
}
