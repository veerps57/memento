// Tests for `embedBatchFallback` — the helper that routes through
// `provider.embedBatch` when available, falling back to sequential
// `embed` calls when it is not.

import { describe, expect, it } from 'vitest';
import { type EmbeddingProvider, embedBatchFallback } from '../../src/embedding/provider.js';

describe('embedBatchFallback', () => {
  it('delegates to embedBatch when present on the provider', async () => {
    let embedCalls = 0;
    let batchCalls = 0;
    const provider: EmbeddingProvider = {
      model: 'test',
      dimension: 2,
      embed: async (_text: string) => {
        embedCalls += 1;
        return [0, 0];
      },
      embedBatch: async (texts: readonly string[]) => {
        batchCalls += 1;
        return texts.map((t) => [t.length, t.length + 1]);
      },
    };

    const results = await embedBatchFallback(provider, ['alpha', 'beta', 'gamma']);

    expect(batchCalls).toBe(1);
    expect(embedCalls).toBe(0);
    expect(results).toHaveLength(3);
  });

  it('falls back to sequential embed calls when embedBatch is absent', async () => {
    let embedCalls = 0;
    const provider: EmbeddingProvider = {
      model: 'test',
      dimension: 2,
      embed: async (text: string) => {
        embedCalls += 1;
        return [text.length, text.length + 1];
      },
    };

    const results = await embedBatchFallback(provider, ['one', 'two', 'three']);

    expect(embedCalls).toBe(3);
    expect(results).toHaveLength(3);
  });

  it('preserves ordering of results from embedBatch', async () => {
    const provider: EmbeddingProvider = {
      model: 'test',
      dimension: 1,
      embed: async () => [0],
      embedBatch: async (texts: readonly string[]) => {
        return texts.map((t) => [t.length]);
      },
    };

    const results = await embedBatchFallback(provider, ['a', 'bb', 'ccc']);

    expect(results[0]).toEqual([1]);
    expect(results[1]).toEqual([2]);
    expect(results[2]).toEqual([3]);
  });

  it('preserves ordering of results from sequential fallback', async () => {
    const provider: EmbeddingProvider = {
      model: 'test',
      dimension: 1,
      embed: async (text: string) => [text.length],
    };

    const results = await embedBatchFallback(provider, ['a', 'bb', 'ccc']);

    expect(results[0]).toEqual([1]);
    expect(results[1]).toEqual([2]);
    expect(results[2]).toEqual([3]);
  });

  it('returns empty array for empty input', async () => {
    let embedCalls = 0;
    const provider: EmbeddingProvider = {
      model: 'test',
      dimension: 2,
      embed: async () => {
        embedCalls += 1;
        return [0, 0];
      },
      embedBatch: async (texts: readonly string[]) => {
        return texts.map(() => [0, 0]);
      },
    };

    const results = await embedBatchFallback(provider, []);

    expect(results).toHaveLength(0);
    expect(embedCalls).toBe(0);
  });
});
