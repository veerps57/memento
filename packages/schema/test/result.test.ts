import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ERROR_CODES,
  ErrorCodeSchema,
  MementoErrorSchema,
  ResultSchema,
  err,
  ok,
} from '../src/result.js';

describe('ErrorCodeSchema', () => {
  it('accepts every documented code', () => {
    for (const c of ERROR_CODES) expect(ErrorCodeSchema.parse(c)).toBe(c);
  });

  it('rejects unknown codes', () => {
    expect(() => ErrorCodeSchema.parse('UNAUTHORIZED')).toThrow();
  });
});

describe('MementoErrorSchema', () => {
  it('accepts a code + message', () => {
    expect(
      MementoErrorSchema.parse({
        code: 'NOT_FOUND',
        message: 'memory missing',
      }),
    ).toEqual({
      code: 'NOT_FOUND',
      message: 'memory missing',
    });
  });

  it('accepts optional details of any JSON shape', () => {
    expect(
      MementoErrorSchema.parse({
        code: 'INVALID_INPUT',
        message: 'bad patch',
        details: { path: ['payload', 'tags'], issue: 'empty' },
      }),
    ).toBeDefined();
  });

  it('rejects empty messages', () => {
    expect(() => MementoErrorSchema.parse({ code: 'INTERNAL', message: '' })).toThrow();
  });

  it('rejects extra fields', () => {
    expect(() =>
      MementoErrorSchema.parse({
        code: 'INTERNAL',
        message: 'x',
        retryable: true,
      } as unknown),
    ).toThrow();
  });

  it('accepts an optional hint', () => {
    expect(
      MementoErrorSchema.parse({
        code: 'STORAGE_ERROR',
        message: 'native binding failed',
        hint: 'Run: npm rebuild better-sqlite3 --build-from-source',
      }),
    ).toEqual({
      code: 'STORAGE_ERROR',
      message: 'native binding failed',
      hint: 'Run: npm rebuild better-sqlite3 --build-from-source',
    });
  });

  it('rejects an empty hint', () => {
    expect(() => MementoErrorSchema.parse({ code: 'INTERNAL', message: 'x', hint: '' })).toThrow();
  });
});

describe('ok / err helpers', () => {
  it('builds Ok envelopes', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('builds Err envelopes', () => {
    expect(err({ code: 'NOT_FOUND', message: 'missing' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'missing' },
    });
  });
});

describe('ResultSchema', () => {
  const Schema = ResultSchema(z.number());

  it('parses Ok envelopes against the value schema', () => {
    expect(Schema.parse({ ok: true, value: 7 })).toEqual({
      ok: true,
      value: 7,
    });
  });

  it('rejects Ok envelopes whose value fails the inner schema', () => {
    expect(() => Schema.parse({ ok: true, value: 'seven' })).toThrow();
  });

  it('parses Err envelopes regardless of value schema', () => {
    expect(
      Schema.parse({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'gone' },
      }),
    ).toBeDefined();
  });

  it('rejects envelopes missing the discriminator', () => {
    expect(() => Schema.parse({ value: 7 } as unknown)).toThrow();
  });

  it('rejects envelopes with extra top-level fields', () => {
    expect(() => Schema.parse({ ok: true, value: 1, trace: 'x' } as unknown)).toThrow();
  });
});
