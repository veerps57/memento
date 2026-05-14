// MMR post-rank diversity pass tests.
//
// Pure-function tests against `applyMMR`. The harness mirrors
// the ranker tests: pre-built result fixtures + a vector lookup
// map fed directly to the function under test, no engine boot
// required.

import type { Memory, MemoryId, Timestamp } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { applyMMR } from '../../src/retrieval/diversity.js';
import type { SearchResult } from '../../src/retrieval/types.js';

const NOW = '2025-06-01T00:00:00.000Z' as unknown as Timestamp;

function makeMemory(id: string): Memory {
  return {
    id: id as unknown as MemoryId,
    scope: { type: 'global' },
    owner: { type: 'local', id: 'tester' },
    kind: { type: 'fact' },
    tags: [],
    pinned: false,
    content: id,
    summary: null,
    storedConfidence: 1,
    status: 'active',
    createdAt: NOW,
    lastConfirmedAt: NOW,
    supersedes: null,
    supersededBy: null,
    embedding: null,
    sensitive: false,
  } as unknown as Memory;
}

function makeResult(id: string, score: number): SearchResult {
  return {
    memory: makeMemory(id),
    score,
    breakdown: { fts: 0, vector: 0, confidence: 0, recency: 0, scope: 0, pinned: 0 },
  };
}

function makeVectorMap(
  entries: readonly { id: string; vector: readonly number[] | null }[],
): ReadonlyMap<string, readonly number[]> {
  const map = new Map<string, readonly number[]>();
  for (const e of entries) {
    if (e.vector !== null) {
      map.set(e.id, e.vector);
    }
  }
  return map;
}

describe('applyMMR', () => {
  it('returns the input unchanged when there are fewer than 2 results', () => {
    expect(applyMMR([], new Map(), { lambda: 0.5, maxDuplicates: 5 })).toEqual([]);
    const single = [makeResult('M1', 1)];
    const vectors = makeVectorMap([{ id: 'M1', vector: [1, 0, 0] }]);
    expect(applyMMR(single, vectors, { lambda: 0.5, maxDuplicates: 5 })).toEqual(single);
  });

  it('lambda = 1 is a passthrough (preserves input order)', () => {
    const ranked = [makeResult('M1', 1.0), makeResult('M2', 0.8), makeResult('M3', 0.6)];
    const vectors = makeVectorMap([
      { id: 'M1', vector: [1, 0, 0] },
      { id: 'M2', vector: [1, 0, 0] }, // duplicate of M1
      { id: 'M3', vector: [0, 1, 0] },
    ]);
    const out = applyMMR(ranked, vectors, { lambda: 1, maxDuplicates: 5 });
    expect(out.map((r) => r.memory.id)).toEqual(['M1', 'M2', 'M3']);
  });

  it('breaks a near-duplicate cluster by promoting a distinct row', () => {
    // M1 (score 1.0) and M2 (score 0.95) are near-duplicates;
    // M3 (score 0.6) is orthogonal. At low lambda, MMR picks
    // M1 then M3 (distinct) before M2.
    const ranked = [makeResult('M1', 1.0), makeResult('M2', 0.95), makeResult('M3', 0.6)];
    const vectors = makeVectorMap([
      { id: 'M1', vector: [1, 0, 0] },
      { id: 'M2', vector: [1, 0, 0] },
      { id: 'M3', vector: [0, 1, 0] },
    ]);
    const out = applyMMR(ranked, vectors, { lambda: 0.3, maxDuplicates: 5 });
    expect(out.map((r) => r.memory.id)).toEqual(['M1', 'M3', 'M2']);
  });

  it('top relevance pick is unchanged regardless of lambda (no predecessors)', () => {
    const ranked = [makeResult('M1', 1.0), makeResult('M2', 0.5)];
    const vectors = makeVectorMap([
      { id: 'M1', vector: [1, 0, 0] },
      { id: 'M2', vector: [1, 0, 0] },
    ]);
    for (const lambda of [0, 0.1, 0.5, 0.9]) {
      const out = applyMMR(ranked, vectors, { lambda, maxDuplicates: 5 });
      expect(out[0]?.memory.id).toBe('M1');
    }
  });

  it('candidates without embeddings ride relevance — no diversity penalty', () => {
    // All three candidates have null vectors. The pass should
    // not rearrange anything; pairwise similarity defaults to
    // 0 so the lambda-weighted MMR collapses to lambda * score.
    const ranked = [makeResult('M1', 1.0), makeResult('M2', 0.5), makeResult('M3', 0.25)];
    const vectors = makeVectorMap([
      { id: 'M1', vector: null },
      { id: 'M2', vector: null },
      { id: 'M3', vector: null },
    ]);
    const out = applyMMR(ranked, vectors, { lambda: 0.2, maxDuplicates: 5 });
    expect(out.map((r) => r.memory.id)).toEqual(['M1', 'M2', 'M3']);
  });

  it('maxDuplicates caps the size of a near-duplicate cluster', () => {
    // Six near-duplicate candidates plus one distinct row. With
    // maxDuplicates = 2, only two near-duplicates of M1 survive
    // before further near-duplicates are skipped.
    const ranked = [
      makeResult('M1', 1.0),
      makeResult('M2', 0.95),
      makeResult('M3', 0.9),
      makeResult('M4', 0.85),
      makeResult('M5', 0.8),
      makeResult('M6', 0.5),
      makeResult('M7', 0.4),
    ];
    const vectors = makeVectorMap([
      { id: 'M1', vector: [1, 0, 0] },
      { id: 'M2', vector: [0.95, 0.05, 0] }, // near M1
      { id: 'M3', vector: [0.94, 0.06, 0] }, // near M1
      { id: 'M4', vector: [0.93, 0.07, 0] }, // near M1
      { id: 'M5', vector: [0.92, 0.08, 0] }, // near M1
      { id: 'M6', vector: [0, 1, 0] }, // distinct
      { id: 'M7', vector: [0, 0.99, 0.01] }, // near M6 (different cluster)
    ]);
    const out = applyMMR(ranked, vectors, { lambda: 0.9, maxDuplicates: 2 });
    // M1 (top), then two near-duplicates land, then orthogonal
    // M6 picks up. M7 lands too because near M6, not M1.
    const ids = out.map((r) => r.memory.id);
    expect(ids[0]).toBe('M1');
    expect(ids).toContain('M6');
    // At least one of M3–M5 should be excluded by the cap.
    const m345 = ids.filter((id) => ['M3', 'M4', 'M5'].includes(String(id)));
    expect(m345.length).toBeLessThan(3);
  });

  it('handles mixed null and vector-bearing picks in the same page', () => {
    // M1 has no embedding (FTS-only candidate); M2 and M3 both
    // have embeddings. After picking M1 (null vector → no
    // penalty contribution to subsequent picks), the maxSim
    // loop sees only vector-bearing picks. M3 (orthogonal to
    // M2) should beat M2 (similar to M2... only M2 is in the
    // picked set, but M2 hasn't been picked yet either — pick
    // order is M1, then between M2/M3 only their relevance
    // scores matter because picked set is null-only).
    const ranked = [makeResult('M1', 1.0), makeResult('M2', 0.9), makeResult('M3', 0.8)];
    const vectors = makeVectorMap([
      { id: 'M1', vector: null }, // FTS-only
      { id: 'M2', vector: [1, 0, 0] },
      { id: 'M3', vector: [0, 1, 0] },
    ]);
    const out = applyMMR(ranked, vectors, { lambda: 0.5, maxDuplicates: 5 });
    expect(out.map((r) => r.memory.id)).toEqual(['M1', 'M2', 'M3']);
  });

  it('null-vector predecessor does not block subsequent maxDuplicates accounting', () => {
    // First pick is FTS-only (null vector); second and third
    // are near-duplicates with vectors. The maxDuplicates loop
    // must skip the null entry in pickedVectors when counting
    // duplicates and still compare against the vector-bearing
    // picks. With maxDuplicates = 1, only one near-duplicate of
    // M2 survives.
    const ranked = [
      makeResult('M1', 1.0),
      makeResult('M2', 0.9),
      makeResult('M3', 0.85),
      makeResult('M4', 0.8),
    ];
    const vectors = makeVectorMap([
      { id: 'M1', vector: null },
      { id: 'M2', vector: [1, 0, 0] },
      { id: 'M3', vector: [1, 0, 0] }, // near-duplicate of M2
      { id: 'M4', vector: [1, 0, 0] }, // near-duplicate of M2
    ]);
    const out = applyMMR(ranked, vectors, { lambda: 0.9, maxDuplicates: 1 });
    const ids = out.map((r) => r.memory.id);
    expect(ids[0]).toBe('M1');
    expect(ids).toContain('M2');
    // Only one of M3/M4 should appear (the other dropped by
    // the maxDuplicates cap).
    const m34 = ids.filter((id) => id === 'M3' || id === 'M4');
    expect(m34).toHaveLength(1);
  });

  it('lambda = 0 picks for diversity over relevance', () => {
    // With lambda = 0 the pass ignores the original scores
    // entirely. After picking M1 (top has no predecessors), it
    // chooses the most distinct candidate next, not the second-
    // most-relevant one.
    const ranked = [makeResult('M1', 1.0), makeResult('M2', 0.95), makeResult('M3', 0.6)];
    const vectors = makeVectorMap([
      { id: 'M1', vector: [1, 0, 0] },
      { id: 'M2', vector: [1, 0, 0] }, // identical to M1
      { id: 'M3', vector: [0, 1, 0] }, // orthogonal to M1
    ]);
    const out = applyMMR(ranked, vectors, { lambda: 0, maxDuplicates: 5 });
    expect(out.map((r) => r.memory.id)).toEqual(['M1', 'M3', 'M2']);
  });
});
