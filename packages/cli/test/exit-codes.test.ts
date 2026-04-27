// Pin the exit-code mapping. Scripts depend on these numbers
// being stable across versions; this test is the contract.

import { ERROR_CODES } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { ERROR_CODE_TO_EXIT, EXIT_OK, EXIT_USAGE, exitCodeFor } from '../src/exit-codes.js';

describe('ERROR_CODE_TO_EXIT', () => {
  it('reserves 0 for ok and 1 for usage/unhandled', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_USAGE).toBe(1);
  });

  it('assigns a unique slot to every ErrorCode', () => {
    const slots = ERROR_CODES.map((code) => ERROR_CODE_TO_EXIT[code]);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('keeps slots disjoint from EXIT_OK and EXIT_USAGE', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CODE_TO_EXIT[code]).not.toBe(EXIT_OK);
      expect(ERROR_CODE_TO_EXIT[code]).not.toBe(EXIT_USAGE);
    }
  });

  it('pins the published numbers (stable contract)', () => {
    expect(ERROR_CODE_TO_EXIT).toEqual({
      INVALID_INPUT: 2,
      NOT_FOUND: 3,
      CONFLICT: 4,
      IMMUTABLE: 5,
      CONFIG_ERROR: 6,
      SCRUBBED: 7,
      STORAGE_ERROR: 8,
      EMBEDDER_ERROR: 9,
      INTERNAL: 10,
    });
  });

  it('exitCodeFor is total over ErrorCode', () => {
    for (const code of ERROR_CODES) {
      expect(typeof exitCodeFor(code)).toBe('number');
    }
  });
});
