import type { Memory, MemoryKindType, Timestamp } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECAY_CONFIG,
  type DecayConfig,
  MS_PER_DAY,
  decayFactor,
  effectiveConfidence,
} from '../../src/decay/engine.js';

const NOW = '2026-01-01T00:00:00.000Z' as Timestamp;
const NOW_MS = Date.parse(NOW as unknown as string);

function memoryFixture(overrides: Partial<Memory> = {}): Memory {
  const base: Memory = {
    id: 'M00000000000000000000000001' as Memory['id'],
    createdAt: NOW as unknown as Memory['createdAt'],
    schemaVersion: 1,
    scope: { type: 'global' },
    owner: { type: 'local', id: 'self' },
    kind: { type: 'fact' },
    tags: [],
    pinned: false,
    content: 'x',
    summary: null,
    status: 'active',
    storedConfidence: 1,
    lastConfirmedAt: NOW as unknown as Memory['lastConfirmedAt'],
    supersedes: null,
    supersededBy: null,
    embedding: null,
    sensitive: false,
  };
  return { ...base, ...overrides } as Memory;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

describe('decayFactor', () => {
  it('is 1 at delta = 0', () => {
    expect(decayFactor(0, MS_PER_DAY)).toBe(1);
  });

  it('is 0.5 at exactly one half-life', () => {
    expect(decayFactor(MS_PER_DAY, MS_PER_DAY)).toBeCloseTo(0.5, 12);
  });

  it('is 0.25 at two half-lives', () => {
    expect(decayFactor(2 * MS_PER_DAY, MS_PER_DAY)).toBeCloseTo(0.25, 12);
  });

  it('clamps non-positive deltas to 1 (no future-confirmation boost)', () => {
    expect(decayFactor(-1_000_000, MS_PER_DAY)).toBe(1);
    expect(decayFactor(0, MS_PER_DAY)).toBe(1);
  });

  it('rejects non-positive half-lives', () => {
    expect(() => decayFactor(1_000, 0)).toThrow(RangeError);
    expect(() => decayFactor(1_000, -1)).toThrow(RangeError);
    expect(() => decayFactor(1_000, Number.NaN)).toThrow(RangeError);
  });
});

describe('effectiveConfidence', () => {
  it('equals storedConfidence when fresh (delta = 0)', () => {
    const m = memoryFixture({ storedConfidence: 0.8 });
    expect(effectiveConfidence(m, NOW)).toBeCloseTo(0.8, 12);
  });

  it('halves at one fact half-life (90 days)', () => {
    const m = memoryFixture({
      storedConfidence: 0.8,
      lastConfirmedAt: isoAt(NOW_MS - 90 * MS_PER_DAY) as unknown as Memory['lastConfirmedAt'],
    });
    expect(effectiveConfidence(m, NOW)).toBeCloseTo(0.4, 12);
  });

  it('uses the kind-specific half-life', () => {
    // todo half-life is 14 days; one half-life should halve.
    const m = memoryFixture({
      kind: { type: 'todo', due: null },
      storedConfidence: 1,
      lastConfirmedAt: isoAt(NOW_MS - 14 * MS_PER_DAY) as unknown as Memory['lastConfirmedAt'],
    });
    expect(effectiveConfidence(m, NOW)).toBeCloseTo(0.5, 12);
  });

  it('floors pinned memories at pinnedFloor regardless of decay', () => {
    const m = memoryFixture({
      pinned: true,
      storedConfidence: 1,
      lastConfirmedAt: isoAt(NOW_MS - 10_000 * MS_PER_DAY) as unknown as Memory['lastConfirmedAt'],
    });
    expect(effectiveConfidence(m, NOW)).toBe(DEFAULT_DECAY_CONFIG.pinnedFloor);
  });

  it('does not raise raw confidence above stored when pinned and fresh', () => {
    const m = memoryFixture({ pinned: true, storedConfidence: 0.9 });
    // fresh (delta = 0) → raw = 0.9, floor 0.5 → max = 0.9.
    expect(effectiveConfidence(m, NOW)).toBeCloseTo(0.9, 12);
  });

  it('throws on a kind with no configured half-life', () => {
    const m = memoryFixture();
    const partial: DecayConfig = {
      ...DEFAULT_DECAY_CONFIG,
      halfLifeByKind: {} as Record<MemoryKindType, number>,
    };
    expect(() => effectiveConfidence(m, NOW, partial)).toThrow(/halfLife/);
  });

  it('rejects malformed timestamps loudly', () => {
    const m = memoryFixture({
      lastConfirmedAt: 'not-a-date' as unknown as Memory['lastConfirmedAt'],
    });
    expect(() => effectiveConfidence(m, NOW)).toThrow();
  });
});

describe('DEFAULT_DECAY_CONFIG', () => {
  it('matches the architecture-doc defaults', () => {
    expect(DEFAULT_DECAY_CONFIG.halfLifeByKind.fact).toBe(90 * MS_PER_DAY);
    expect(DEFAULT_DECAY_CONFIG.halfLifeByKind.preference).toBe(180 * MS_PER_DAY);
    expect(DEFAULT_DECAY_CONFIG.halfLifeByKind.decision).toBe(365 * MS_PER_DAY);
    expect(DEFAULT_DECAY_CONFIG.halfLifeByKind.todo).toBe(14 * MS_PER_DAY);
    expect(DEFAULT_DECAY_CONFIG.halfLifeByKind.snippet).toBe(30 * MS_PER_DAY);
    expect(DEFAULT_DECAY_CONFIG.pinnedFloor).toBe(0.5);
    expect(DEFAULT_DECAY_CONFIG.archiveThreshold).toBe(0.05);
    expect(DEFAULT_DECAY_CONFIG.archiveAfterMs).toBe(365 * MS_PER_DAY);
  });
});
