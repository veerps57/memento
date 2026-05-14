// Reciprocal Rank Fusion ranker tests.
//
// Pure-function tests against `rankRRF`. The harness mirrors the
// linear-ranker tests so the two stay structurally readable
// side-by-side.

import type { Memory, MemoryId, Timestamp } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DECAY_CONFIG } from '../../src/decay/engine.js';
import type { RankerOptions, RankerWeights } from '../../src/retrieval/ranker.js';
import { rankRRF } from '../../src/retrieval/ranker.js';

const ZERO_WEIGHTS: RankerWeights = {
  fts: 0,
  vector: 0,
  confidence: 0,
  recency: 0,
  scope: 0,
  pinned: 0,
};

const NOW = '2025-06-01T00:00:00.000Z' as unknown as Timestamp;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const base: Memory = {
    id: 'M0000000000000000000000001' as unknown as MemoryId,
    scope: { type: 'global' },
    owner: { type: 'local', id: 'tester' },
    kind: { type: 'fact' },
    tags: [],
    pinned: false,
    content: 'x',
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
  return { ...base, ...overrides } as Memory;
}

function options(overrides: Partial<RankerOptions> = {}): RankerOptions {
  return {
    weights: ZERO_WEIGHTS,
    recencyHalfLifeMs: 0,
    scopeBoostPerLevel: 0.1,
    now: NOW,
    decayConfig: DEFAULT_DECAY_CONFIG,
    rrfK: 60,
    ...overrides,
  };
}

describe('rankRRF', () => {
  it('returns empty when there are no candidates', () => {
    expect(rankRRF([], new Map(), options())).toEqual([]);
  });

  it('drops candidates whose memory is missing', () => {
    const out = rankRRF(
      [{ id: 'missing' as unknown as MemoryId, bm25: -2, cosine: null, vector: null }],
      new Map(),
      options(),
    );
    expect(out).toEqual([]);
  });

  it('throws on invalid `now`', () => {
    const m = makeMemory();
    const map = new Map([[m.id as unknown as string, m]]);
    expect(() =>
      rankRRF(
        [{ id: m.id, bm25: -1, cosine: null, vector: null }],
        map,
        options({ now: 'not-a-date' as unknown as Timestamp }),
      ),
    ).toThrow(/not a valid ISO timestamp/);
  });

  it('assigns inverse-rank by FTS position (more-negative bm25 ranks first)', () => {
    const m1 = makeMemory({ id: 'M1' as unknown as MemoryId });
    const m2 = makeMemory({ id: 'M2' as unknown as MemoryId });
    const map = new Map([
      [m1.id as unknown as string, m1],
      [m2.id as unknown as string, m2],
    ]);
    const out = rankRRF(
      [
        { id: m1.id, bm25: -10, cosine: null, vector: null }, // strongest FTS
        { id: m2.id, bm25: -2, cosine: null, vector: null }, // weaker FTS
      ],
      map,
      options({ weights: { ...ZERO_WEIGHTS, fts: 1 }, rrfK: 60 }),
    );
    expect(out[0]?.memory.id).toBe(m1.id);
    expect(out[0]?.breakdown.fts).toBeCloseTo(1 / 61, 10); // rank 1
    expect(out[1]?.breakdown.fts).toBeCloseTo(1 / 62, 10); // rank 2
  });

  it('assigns inverse-rank by vector position (higher cosine ranks first)', () => {
    const m1 = makeMemory({ id: 'M1' as unknown as MemoryId });
    const m2 = makeMemory({ id: 'M2' as unknown as MemoryId });
    const map = new Map([
      [m1.id as unknown as string, m1],
      [m2.id as unknown as string, m2],
    ]);
    const out = rankRRF(
      [
        { id: m1.id, bm25: null, cosine: 0.95, vector: null }, // strongest vector
        { id: m2.id, bm25: null, cosine: 0.7, vector: null }, // weaker vector
      ],
      map,
      options({ weights: { ...ZERO_WEIGHTS, vector: 1 }, rrfK: 60 }),
    );
    expect(out[0]?.memory.id).toBe(m1.id);
    expect(out[0]?.breakdown.vector).toBeCloseTo(1 / 61, 10);
    expect(out[1]?.breakdown.vector).toBeCloseTo(1 / 62, 10);
  });

  it('null arm contributes 0 to the breakdown', () => {
    const m = makeMemory();
    const map = new Map([[m.id as unknown as string, m]]);
    const out = rankRRF(
      [{ id: m.id, bm25: -1, cosine: null, vector: null }],
      map,
      options({ weights: { ...ZERO_WEIGHTS, fts: 1, vector: 1 } }),
    );
    expect(out[0]?.breakdown.fts).toBeCloseTo(1 / 61, 10);
    expect(out[0]?.breakdown.vector).toBe(0);
  });

  it('two arms agree — both candidates rank above single-arm matches', () => {
    // Three candidates: M1 matches both arms at top rank, M2
    // matches only FTS, M3 matches only vector. RRF says M1
    // should land first (it has TWO non-zero terms while the
    // others have only one).
    const m1 = makeMemory({ id: 'M1' as unknown as MemoryId });
    const m2 = makeMemory({ id: 'M2' as unknown as MemoryId });
    const m3 = makeMemory({ id: 'M3' as unknown as MemoryId });
    const map = new Map([
      [m1.id as unknown as string, m1],
      [m2.id as unknown as string, m2],
      [m3.id as unknown as string, m3],
    ]);
    const out = rankRRF(
      [
        { id: m1.id, bm25: -10, cosine: 0.95, vector: null },
        { id: m2.id, bm25: -8, cosine: null, vector: null },
        { id: m3.id, bm25: null, cosine: 0.9, vector: null },
      ],
      map,
      options({ weights: { ...ZERO_WEIGHTS, fts: 1, vector: 1 } }),
    );
    expect(out[0]?.memory.id).toBe(m1.id);
    // M1 = 1/61 + 1/61; M2 and M3 = 1/61 each. M1 dominates.
    expect(out[0]?.score).toBeGreaterThan(out[1]?.score ?? Number.POSITIVE_INFINITY);
  });

  it('regression: strong FTS rescues a memory with no vector contribution', () => {
    // The "F-forgotten-explicit" pattern: one row has a perfect
    // FTS match but no vector (e.g. forgotten row, no embedding);
    // another row has a strong cosine but no FTS overlap. Under
    // the linear ranker's batch-max normalisation a third row
    // with vector 0.95 + FTS 0 can swamp the FTS-only row. With
    // RRF the FTS-only row gets rank 1 on FTS, so the inverse-
    // rank contribution is the maximum possible — it must
    // outrank a vector-only candidate at the same arm weight.
    const ftsOnly = makeMemory({ id: 'Mftsonly' as unknown as MemoryId });
    const vectorOnly = makeMemory({ id: 'Mvconly' as unknown as MemoryId });
    const map = new Map([
      [ftsOnly.id as unknown as string, ftsOnly],
      [vectorOnly.id as unknown as string, vectorOnly],
    ]);
    const out = rankRRF(
      [
        { id: ftsOnly.id, bm25: -5, cosine: null, vector: null },
        { id: vectorOnly.id, bm25: null, cosine: 0.95, vector: null },
      ],
      map,
      options({ weights: { ...ZERO_WEIGHTS, fts: 1, vector: 1 } }),
    );
    // Both have inverse-rank 1/(k+1) on their single arm — ties
    // resolve by id descending.
    expect(out[0]?.score).toBe(out[1]?.score);
  });

  it('higher k flattens the contribution curve', () => {
    const m1 = makeMemory({ id: 'M1' as unknown as MemoryId });
    const m2 = makeMemory({ id: 'M2' as unknown as MemoryId });
    const map = new Map([
      [m1.id as unknown as string, m1],
      [m2.id as unknown as string, m2],
    ]);
    const cands = [
      { id: m1.id, bm25: -10, cosine: null, vector: null },
      { id: m2.id, bm25: -2, cosine: null, vector: null },
    ];

    const tight = rankRRF(cands, map, options({ weights: { ...ZERO_WEIGHTS, fts: 1 }, rrfK: 1 }));
    const flat = rankRRF(cands, map, options({ weights: { ...ZERO_WEIGHTS, fts: 1 }, rrfK: 1000 }));

    // The ratio of rank-1 to rank-2 contribution shrinks as k
    // grows. tight: 1/2 ÷ 1/3 = 1.5; flat: 1/1001 ÷ 1/1002 ≈ 1.001.
    const tightRatio = (tight[0]?.score ?? 1) / (tight[1]?.score ?? 1);
    const flatRatio = (flat[0]?.score ?? 1) / (flat[1]?.score ?? 1);
    expect(tightRatio).toBeGreaterThan(flatRatio);
    expect(tightRatio).toBeCloseTo(1.5, 5);
    expect(flatRatio).toBeLessThan(1.01);
  });

  it('applies recency half-life identically to rankLinear', () => {
    const halfAgo = makeMemory({
      lastConfirmedAt: '2025-05-02T00:00:00.000Z' as unknown as Timestamp, // 30d before NOW
    });
    const map = new Map([[halfAgo.id as unknown as string, halfAgo]]);
    const out = rankRRF(
      [{ id: halfAgo.id, bm25: null, cosine: null, vector: null }],
      map,
      options({
        recencyHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
        weights: { ...ZERO_WEIGHTS, recency: 1 },
      }),
    );
    expect(out[0]?.breakdown.recency).toBeCloseTo(0.5, 5);
  });

  it('applies scope-specificity boost when scopes are layered', () => {
    const specific = makeMemory({
      id: 'Mspec' as unknown as MemoryId,
      scope: { type: 'workspace', path: '/x' as never },
    });
    const broad = makeMemory({
      id: 'Mbroad' as unknown as MemoryId,
      scope: { type: 'global' },
    });
    const map = new Map([
      [specific.id as unknown as string, specific],
      [broad.id as unknown as string, broad],
    ]);
    const out = rankRRF(
      [
        { id: broad.id, bm25: null, cosine: null, vector: null },
        { id: specific.id, bm25: null, cosine: null, vector: null },
      ],
      map,
      options({
        weights: { ...ZERO_WEIGHTS, scope: 1 },
        scopeBoostPerLevel: 0.1,
        scopes: [{ type: 'workspace', path: '/x' as never }, { type: 'global' }],
      }),
    );
    expect(out[0]?.memory.id).toBe(specific.id);
    expect(out[0]?.breakdown.scope).toBeCloseTo(0.1, 5);
    expect(out[1]?.breakdown.scope).toBe(0);
  });

  it('baseline arms (confidence, recency, scope, pinned) compose with the RRF arms', () => {
    // RRF FTS-only candidate. Without the pinned arm weight,
    // both would tie on score. With pinned weight 1, the pinned
    // memory must rank first.
    const pinned = makeMemory({ id: 'Mp' as unknown as MemoryId, pinned: true });
    const plain = makeMemory({ id: 'Mn' as unknown as MemoryId });
    const map = new Map([
      [pinned.id as unknown as string, pinned],
      [plain.id as unknown as string, plain],
    ]);
    const out = rankRRF(
      [
        { id: pinned.id, bm25: -5, cosine: null, vector: null },
        { id: plain.id, bm25: -5, cosine: null, vector: null },
      ],
      map,
      options({ weights: { ...ZERO_WEIGHTS, fts: 1, pinned: 1 } }),
    );
    expect(out[0]?.memory.id).toBe(pinned.id);
    expect(out[0]?.breakdown.pinned).toBe(1);
    expect(out[1]?.breakdown.pinned).toBe(0);
  });

  it('uses default k=60 when rrfK is omitted', () => {
    const m = makeMemory();
    const map = new Map([[m.id as unknown as string, m]]);
    const omitted: RankerOptions = {
      weights: { ...ZERO_WEIGHTS, fts: 1 },
      recencyHalfLifeMs: 0,
      scopeBoostPerLevel: 0.1,
      now: NOW,
      decayConfig: DEFAULT_DECAY_CONFIG,
    };
    const out = rankRRF([{ id: m.id, bm25: -1, cosine: null, vector: null }], map, omitted);
    expect(out[0]?.breakdown.fts).toBeCloseTo(1 / 61, 10); // k=60 + rank=1
  });

  it('demotes a superseded predecessor when its successor is co-present', () => {
    const b = makeMemory({ id: 'Mb' as unknown as MemoryId });
    const a = makeMemory({
      id: 'Ma' as unknown as MemoryId,
      status: 'superseded',
      supersededBy: b.id,
    });
    const map = new Map([
      [a.id as unknown as string, a],
      [b.id as unknown as string, b],
    ]);
    const out = rankRRF(
      [
        { id: a.id, bm25: -1, cosine: null, vector: null },
        { id: b.id, bm25: -2, cosine: null, vector: null }, // B has stronger FTS so it lands rank 1
      ],
      map,
      options({
        weights: { ...ZERO_WEIGHTS, fts: 1 },
        supersedingMultiplier: 0.5,
      }),
    );
    expect(out[0]?.memory.id).toBe(b.id);
    expect(out[1]?.memory.id).toBe(a.id);
    // A's inverse-rank score (1/62) gets halved by the multiplier.
    expect(out[1]?.score).toBeCloseTo((1 / 62) * 0.5, 10);
  });

  it('does not demote when the successor is absent', () => {
    const a = makeMemory({
      id: 'Ma' as unknown as MemoryId,
      status: 'superseded',
      supersededBy: 'Mghost' as unknown as MemoryId,
    });
    const map = new Map([[a.id as unknown as string, a]]);
    const out = rankRRF(
      [{ id: a.id, bm25: -1, cosine: null, vector: null }],
      map,
      options({
        weights: { ...ZERO_WEIGHTS, fts: 1 },
        supersedingMultiplier: 0.5,
      }),
    );
    expect(out[0]?.score).toBeCloseTo(1 / 61, 10);
  });

  it('breaks score ties by id descending (newer ULIDs win)', () => {
    const a = makeMemory({ id: 'M01' as unknown as MemoryId });
    const b = makeMemory({ id: 'M02' as unknown as MemoryId });
    const map = new Map([
      [a.id as unknown as string, a],
      [b.id as unknown as string, b],
    ]);
    const out = rankRRF(
      [
        { id: a.id, bm25: null, cosine: null, vector: null },
        { id: b.id, bm25: null, cosine: null, vector: null },
      ],
      map,
      options(),
    );
    expect(out.map((r) => r.memory.id)).toEqual([b.id, a.id]);
  });
});
