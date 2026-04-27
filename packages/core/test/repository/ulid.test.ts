import { describe, expect, it } from 'vitest';
import { ulid } from '../../src/repository/ulid.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('ulid', () => {
  it('produces a 26-char Crockford-base32 string', () => {
    for (let i = 0; i < 64; i += 1) {
      expect(ulid()).toMatch(ULID_RE);
    }
  });

  it('is monotonic across many calls in a single process', () => {
    let prev = ulid();
    for (let i = 0; i < 1024; i += 1) {
      const next = ulid();
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  it('encodes the supplied timestamp in the first 10 chars', () => {
    // 2024-05-04T12:00:00.000Z = 1714824000000 ms
    const id = ulid(1714824000000);
    expect(id.slice(0, 10)).toBe('01HX1QKCG0');
  });

  it('rejects out-of-range timestamps', () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(0xffff_ffff_ffff + 1)).toThrow(RangeError);
  });

  it('keeps strict monotonicity even when the clock does not advance', () => {
    const t = 1714824000000;
    const a = ulid(t);
    const b = ulid(t);
    expect(b > a).toBe(true);
    expect(b.slice(0, 10)).toBe(a.slice(0, 10)); // same time prefix
  });
});
