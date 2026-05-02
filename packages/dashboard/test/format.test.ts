// Unit tests for `src/ui/lib/format.ts`.
//
// Pure-function tier (testing tier A). No React, no fetch, no
// React Query — these helpers convert raw API values into
// human-readable display strings and run identically in any
// environment. Cheap to test, large coverage payoff.

import { describe, expect, it } from 'vitest';

import { compactNumber, formatScope, relativeTime } from '../src/ui/lib/format.js';

describe('relativeTime', () => {
  // Use a fixed `now` so the assertions are deterministic across
  // CI runs that don't share a wall clock with the test author.
  const NOW = Date.UTC(2026, 4, 2, 12, 0, 0); // 2026-05-02T12:00:00Z

  function past(ms: number): string {
    return new Date(NOW - ms).toISOString();
  }

  function future(ms: number): string {
    return new Date(NOW + ms).toISOString();
  }

  it('renders "—" for null and undefined', () => {
    expect(relativeTime(null, NOW)).toBe('—');
    expect(relativeTime(undefined, NOW)).toBe('—');
  });

  it('renders "—" for unparseable input', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('—');
  });

  it('renders "just now" for sub-second past timestamps', () => {
    expect(relativeTime(past(500), NOW)).toBe('just now');
  });

  it('renders "now" for sub-second future timestamps', () => {
    expect(relativeTime(future(500), NOW)).toBe('now');
  });

  it('renders the smallest applicable unit with " ago" for the past', () => {
    expect(relativeTime(past(5_000), NOW)).toMatch(/ ago$/);
    expect(relativeTime(past(60_000 * 5), NOW)).toMatch(/ ago$/);
    expect(relativeTime(past(3_600_000 * 3), NOW)).toMatch(/ ago$/);
    expect(relativeTime(past(86_400_000 * 4), NOW)).toMatch(/ ago$/);
  });

  it('renders " from now" for the future', () => {
    expect(relativeTime(future(60_000 * 30), NOW)).toMatch(/ from now$/);
  });

  it('renders years for ages older than a year', () => {
    const twoYears = 2 * 365 * 86_400_000;
    expect(relativeTime(past(twoYears), NOW)).toMatch(/^\d+y ago$/);
  });
});

describe('formatScope', () => {
  it('renders global as "global" verbatim', () => {
    expect(formatScope({ type: 'global' })).toBe('global');
  });

  it('renders workspace with the path', () => {
    expect(formatScope({ type: 'workspace', path: '/Users/x/proj' })).toBe(
      'workspace:/Users/x/proj',
    );
  });

  it('renders repo with the canonicalised remote', () => {
    expect(formatScope({ type: 'repo', remote: 'github.com/acme/widget' })).toBe(
      'repo:github.com/acme/widget',
    );
  });

  it('renders branch with remote@branch', () => {
    expect(
      formatScope({ type: 'branch', remote: 'github.com/acme/widget', branch: 'feat/x' }),
    ).toBe('branch:github.com/acme/widget@feat/x');
  });

  it('renders session with the id', () => {
    expect(formatScope({ type: 'session', id: '01HYXZ' })).toBe('session:01HYXZ');
  });

  it('falls back to the discriminator alone for unknown variants', () => {
    // Forward-compat: a future scope type should at least show
    // its name rather than crash.
    expect(formatScope({ type: 'cluster', cluster: 'foo' })).toBe('cluster');
  });
});

describe('compactNumber', () => {
  it('returns the number verbatim under 1000', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(42)).toBe('42');
    expect(compactNumber(999)).toBe('999');
  });

  it('uses k with one decimal under 10000', () => {
    expect(compactNumber(1_234)).toBe('1.2k');
    expect(compactNumber(9_999)).toBe('10.0k');
  });

  it('uses k with no decimal between 10k and 1M', () => {
    expect(compactNumber(15_000)).toBe('15k');
    expect(compactNumber(999_000)).toBe('999k');
  });

  it('uses M with one decimal under 10M', () => {
    expect(compactNumber(1_500_000)).toBe('1.5M');
  });

  it('uses M with no decimal at and above 10M', () => {
    expect(compactNumber(15_000_000)).toBe('15M');
  });
});
