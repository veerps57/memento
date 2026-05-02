// Unit tests for the client-side decay helper.
//
// The dashboard renders effective confidence (decay-aware) in
// the memory list and detail views. The server computes the
// canonical value at query time; the dashboard mirrors the
// formula so a row's badge does not require a round trip per
// memory. These tests pin the formula contract.

import { describe, expect, it } from 'vitest';

import { DEFAULT_HALF_LIFE_DAYS, effectiveConfidence } from '../src/ui/lib/decay.js';

const DAY_MS = 86_400_000;

function memory(
  kind: keyof typeof DEFAULT_HALF_LIFE_DAYS,
  storedConfidence: number,
  ageDays: number,
  pinned = false,
  now: number = Date.now(),
) {
  return {
    kind: { type: kind },
    storedConfidence,
    pinned,
    lastConfirmedAt: new Date(now - ageDays * DAY_MS).toISOString(),
  };
}

describe('effectiveConfidence', () => {
  it('returns stored value at age=0', () => {
    const now = Date.now();
    const m = memory('fact', 1, 0, false, now);
    expect(effectiveConfidence(m, now)).toBeCloseTo(1, 5);
  });

  it('halves at one half-life', () => {
    const now = Date.now();
    const m = memory('fact', 1, DEFAULT_HALF_LIFE_DAYS.fact, false, now);
    expect(effectiveConfidence(m, now)).toBeCloseTo(0.5, 4);
  });

  it('quarters at two half-lives', () => {
    const now = Date.now();
    const m = memory('fact', 1, DEFAULT_HALF_LIFE_DAYS.fact * 2, false, now);
    expect(effectiveConfidence(m, now)).toBeCloseTo(0.25, 4);
  });

  it('uses the right half-life per kind', () => {
    // 14d on `todo` is one half-life → 0.5; on `decision` it's
    // tiny because the half-life is 365d.
    const now = Date.now();
    const todo = memory('todo', 1, 14, false, now);
    const decision = memory('decision', 1, 14, false, now);
    expect(effectiveConfidence(todo, now)).toBeCloseTo(0.5, 4);
    expect(effectiveConfidence(decision, now)).toBeGreaterThan(0.95);
  });

  it('floors pinned memories at the pinned floor', () => {
    // Way past 10 half-lives — without the floor this would be ~0.
    const now = Date.now();
    const m = memory('fact', 1, DEFAULT_HALF_LIFE_DAYS.fact * 10, true, now);
    expect(effectiveConfidence(m, now)).toBeCloseTo(0.5, 4);
  });

  it('does not apply the pinned floor to unpinned memories', () => {
    const now = Date.now();
    const m = memory('fact', 1, DEFAULT_HALF_LIFE_DAYS.fact * 10, false, now);
    expect(effectiveConfidence(m, now)).toBeLessThan(0.01);
  });

  it('returns stored value when lastConfirmedAt is unparseable', () => {
    expect(
      effectiveConfidence({
        kind: { type: 'fact' },
        storedConfidence: 0.7,
        pinned: false,
        lastConfirmedAt: 'not-a-date',
      }),
    ).toBeCloseTo(0.7, 5);
  });

  it('clamps the result to [0, 1]', () => {
    const now = Date.now();
    // A future lastConfirmedAt would make ageDays negative; the
    // helper clamps that to zero so we don't get >1 confidence.
    const m = memory('fact', 1, -100, false, now);
    expect(effectiveConfidence(m, now)).toBeLessThanOrEqual(1);
    expect(effectiveConfidence(m, now)).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the fact half-life for unknown kinds', () => {
    const now = Date.now();
    const m = {
      kind: { type: 'mystery' },
      storedConfidence: 1,
      pinned: false,
      lastConfirmedAt: new Date(now - DEFAULT_HALF_LIFE_DAYS.fact * DAY_MS).toISOString(),
    };
    // One fact half-life → 0.5 if the fallback works.
    expect(effectiveConfidence(m, now)).toBeCloseTo(0.5, 4);
  });
});
