import type { Memory, MemoryId, Timestamp } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DECAY_CONFIG } from '../../src/decay/engine.js';
import { rankLinear } from '../../src/retrieval/ranker.js';
import type { RankerOptions, RankerWeights } from '../../src/retrieval/ranker.js';

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
    ...overrides,
  };
}

describe('rankLinear', () => {
  it('returns empty when there are no candidates', () => {
    expect(rankLinear([], new Map(), options())).toEqual([]);
  });

  it('drops candidates whose memory is missing', () => {
    const out = rankLinear(
      [{ id: 'missing' as unknown as MemoryId, bm25: -2, cosine: null, vector: null }],
      new Map(),
      options(),
    );
    expect(out).toEqual([]);
  });

  it('normalises bm25 across the batch (best=1)', () => {
    const m1 = makeMemory({ id: 'M1' as unknown as MemoryId });
    const m2 = makeMemory({ id: 'M2' as unknown as MemoryId });
    const map = new Map([
      [m1.id as unknown as string, m1],
      [m2.id as unknown as string, m2],
    ]);
    const out = rankLinear(
      [
        { id: m1.id, bm25: -10, cosine: null, vector: null },
        { id: m2.id, bm25: -2, cosine: null, vector: null },
      ],
      map,
      options({ weights: { ...ZERO_WEIGHTS, fts: 1 } }),
    );
    expect(out[0]?.memory.id).toBe(m1.id);
    expect(out[0]?.breakdown.fts).toBe(1);
    expect(out[1]?.breakdown.fts).toBeCloseTo(0.2, 5);
  });

  it('disables recency when halfLife is 0', () => {
    const old = makeMemory({
      id: 'Mold' as unknown as MemoryId,
      lastConfirmedAt: '2020-01-01T00:00:00.000Z' as unknown as Timestamp,
    });
    const map = new Map([[old.id as unknown as string, old]]);
    const out = rankLinear(
      [{ id: old.id, bm25: null, cosine: null, vector: null }],
      map,
      options({
        recencyHalfLifeMs: 0,
        weights: { ...ZERO_WEIGHTS, recency: 1 },
      }),
    );
    expect(out[0]?.breakdown.recency).toBe(0);
  });

  it('applies recency half-life when configured', () => {
    const halfAgo = makeMemory({
      lastConfirmedAt: '2025-05-02T00:00:00.000Z' as unknown as Timestamp, // 30d before NOW
    });
    const map = new Map([[halfAgo.id as unknown as string, halfAgo]]);
    const out = rankLinear(
      [{ id: halfAgo.id, bm25: null, cosine: null, vector: null }],
      map,
      options({
        recencyHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
        weights: { ...ZERO_WEIGHTS, recency: 1 },
      }),
    );
    expect(out[0]?.breakdown.recency).toBeCloseTo(0.5, 5);
  });

  it('rewards scope specificity per scopeBoost', () => {
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
    const out = rankLinear(
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

  it('adds the pinned bonus only to pinned memories', () => {
    const pinned = makeMemory({
      id: 'Mp' as unknown as MemoryId,
      pinned: true,
    });
    const plain = makeMemory({ id: 'Mn' as unknown as MemoryId });
    const map = new Map([
      [pinned.id as unknown as string, pinned],
      [plain.id as unknown as string, plain],
    ]);
    const out = rankLinear(
      [
        { id: plain.id, bm25: null, cosine: null, vector: null },
        { id: pinned.id, bm25: null, cosine: null, vector: null },
      ],
      map,
      options({ weights: { ...ZERO_WEIGHTS, pinned: 1 } }),
    );
    expect(out[0]?.memory.id).toBe(pinned.id);
    expect(out[0]?.score).toBe(1);
    expect(out[1]?.score).toBe(0);
  });

  it('throws on invalid `now`', () => {
    const m = makeMemory();
    const map = new Map([[m.id as unknown as string, m]]);
    expect(() =>
      rankLinear(
        [{ id: m.id, bm25: -1, cosine: null, vector: null }],
        map,
        options({ now: 'not-a-date' as unknown as Timestamp }),
      ),
    ).toThrow(/not a valid ISO timestamp/);
  });

  it('does not demote a status=superseded memory with null supersededBy', () => {
    // Pathological/legacy shape — `supersededBy` is null even
    // though status flipped to 'superseded'. Supersession
    // atomicity prevents this in production writes, but the
    // ranker guard still has to return early when the pointer
    // is absent (no successor to compare against).
    const m = makeMemory({
      id: 'Mlegacy' as unknown as MemoryId,
      status: 'superseded',
      supersededBy: null,
    });
    const map = new Map([[m.id as unknown as string, m]]);
    const out = rankLinear(
      [{ id: m.id, bm25: -1, cosine: null, vector: null }],
      map,
      options({
        weights: { ...ZERO_WEIGHTS, fts: 1 },
        supersedingMultiplier: 0.5,
      }),
    );
    expect(out[0]?.score).toBeCloseTo(1, 5); // No demotion applied.
  });

  it('demotes a superseded predecessor when its successor is co-present', () => {
    // A (superseded by B) and B (active). At equal raw scores
    // the multiplier puts B above A.
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
    const out = rankLinear(
      [
        { id: a.id, bm25: -1, cosine: null, vector: null },
        { id: b.id, bm25: -1, cosine: null, vector: null },
      ],
      map,
      options({
        weights: { ...ZERO_WEIGHTS, fts: 1 },
        supersedingMultiplier: 0.5,
      }),
    );
    expect(out[0]?.memory.id).toBe(b.id);
    expect(out[1]?.memory.id).toBe(a.id);
    expect(out[1]?.score).toBeCloseTo((out[0]?.score ?? 0) * 0.5, 5);
  });

  it('does not demote when the successor is absent from the result set', () => {
    // A is superseded but B is not co-present. A keeps its full
    // score — the caller fetched the predecessor in isolation.
    const orphanSupersededBy = 'Mghost' as unknown as MemoryId;
    const a = makeMemory({
      id: 'Ma' as unknown as MemoryId,
      status: 'superseded',
      supersededBy: orphanSupersededBy,
    });
    const map = new Map([[a.id as unknown as string, a]]);
    const out = rankLinear(
      [{ id: a.id, bm25: -1, cosine: null, vector: null }],
      map,
      options({
        weights: { ...ZERO_WEIGHTS, fts: 1 },
        supersedingMultiplier: 0.5,
      }),
    );
    expect(out[0]?.score).toBeCloseTo(1, 5); // FTS=1.0 normalised
  });

  it('multiplier 1.0 disables demotion (passthrough)', () => {
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
    const out = rankLinear(
      [
        { id: a.id, bm25: -1, cosine: null, vector: null },
        { id: b.id, bm25: -1, cosine: null, vector: null },
      ],
      map,
      options({
        weights: { ...ZERO_WEIGHTS, fts: 1 },
        supersedingMultiplier: 1.0,
      }),
    );
    // Multiplier 1.0 means no demotion — id-desc tie-break
    // applies (Mb > Ma).
    expect(out[0]?.memory.id).toBe(b.id);
    expect(out[1]?.score).toBe(out[0]?.score);
  });

  it('breaks score ties by id descending', () => {
    const a = makeMemory({ id: 'M01' as unknown as MemoryId });
    const b = makeMemory({ id: 'M02' as unknown as MemoryId });
    const map = new Map([
      [a.id as unknown as string, a],
      [b.id as unknown as string, b],
    ]);
    const out = rankLinear(
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
