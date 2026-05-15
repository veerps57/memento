import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCAL_DIMENSION,
  DEFAULT_LOCAL_MODEL,
  type EmbedBatchFn,
  type EmbedFn,
  type LocalEmbedderLoader,
  createLocalEmbedder,
} from '../src/index.js';

// All tests inject a fake loader. The default loader is
// covered separately by the manual integration check
// documented in the package README; running it in CI would
// require downloading a ~110 MB model on every test run.

const buildVector = (length: number, fill = 0): number[] => {
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    out.push(fill);
  }
  return out;
};

describe('createLocalEmbedder', () => {
  let loader: ReturnType<typeof vi.fn> & LocalEmbedderLoader;
  let embedFn: ReturnType<typeof vi.fn> & EmbedFn;

  beforeEach(() => {
    embedFn = vi.fn(async (_text: string) =>
      buildVector(DEFAULT_LOCAL_DIMENSION, 0.1),
    ) as ReturnType<typeof vi.fn> & EmbedFn;
    loader = vi.fn(async () => ({ embed: embedFn })) as ReturnType<typeof vi.fn> &
      LocalEmbedderLoader;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces the default model and dimension', () => {
    const provider = createLocalEmbedder({ loader });
    expect(provider.model).toBe(DEFAULT_LOCAL_MODEL);
    expect(provider.dimension).toBe(DEFAULT_LOCAL_DIMENSION);
  });

  it('does not invoke the loader at construction time', () => {
    createLocalEmbedder({ loader });
    expect(loader).not.toHaveBeenCalled();
  });

  it('invokes the loader exactly once across concurrent embed calls', async () => {
    const provider = createLocalEmbedder({ loader });
    const [a, b, c] = await Promise.all([
      provider.embed('alpha'),
      provider.embed('beta'),
      provider.embed('gamma'),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(a).toHaveLength(DEFAULT_LOCAL_DIMENSION);
    expect(b).toHaveLength(DEFAULT_LOCAL_DIMENSION);
    expect(c).toHaveLength(DEFAULT_LOCAL_DIMENSION);
  });

  it('caches the loader across sequential embed calls', async () => {
    const provider = createLocalEmbedder({ loader });
    await provider.embed('first');
    await provider.embed('second');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledTimes(2);
  });

  it('forwards the configured model and cacheDir to the loader', async () => {
    const customEmbed: EmbedFn = async () => buildVector(384, 0.1);
    const customLoader: ReturnType<typeof vi.fn> & LocalEmbedderLoader = vi.fn(async () => ({
      embed: customEmbed,
    }));
    const provider = createLocalEmbedder({
      loader: customLoader,
      model: 'all-MiniLM-L6-v2',
      dimension: 384,
      cacheDir: '/tmp/memento-models',
    });
    expect(provider.model).toBe('all-MiniLM-L6-v2');
    await provider.embed('hello');
    expect(customLoader).toHaveBeenCalledWith('all-MiniLM-L6-v2', {
      cacheDir: '/tmp/memento-models',
    });
  });

  it('omits cacheDir from the loader context when not configured', async () => {
    const provider = createLocalEmbedder({ loader });
    await provider.embed('hello');
    expect(loader).toHaveBeenCalledWith(DEFAULT_LOCAL_MODEL, {});
  });

  it('throws when the produced vector length does not match the dimension', async () => {
    const wrongLength: EmbedFn = async () => buildVector(10, 0);
    const wrongLoader: LocalEmbedderLoader = async () => ({ embed: wrongLength });
    const provider = createLocalEmbedder({ loader: wrongLoader });
    await expect(provider.embed('hi')).rejects.toThrow(/length 10, expected 768/);
  });

  it('honours an overridden dimension when validating output', async () => {
    const tinyEmbed: EmbedFn = async () => buildVector(8, 0.5);
    const tinyLoader: LocalEmbedderLoader = async () => ({ embed: tinyEmbed });
    const provider = createLocalEmbedder({ loader: tinyLoader, dimension: 8 });
    const v = await provider.embed('x');
    expect(v).toHaveLength(8);
  });

  describe('warmup', () => {
    it('drives loader initialisation without producing a vector', async () => {
      const provider = createLocalEmbedder({ loader });
      expect(provider.warmup).toBeDefined();
      await provider.warmup?.();
      expect(loader).toHaveBeenCalledTimes(1);
      // No embed call was issued — warmup runs the init only.
      expect(embedFn).not.toHaveBeenCalled();
    });

    it('shares its in-flight init with concurrent embed calls', async () => {
      const provider = createLocalEmbedder({ loader });
      const [, vector] = await Promise.all([provider.warmup?.(), provider.embed('first')]);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(vector).toHaveLength(DEFAULT_LOCAL_DIMENSION);
    });

    it('is a no-op on repeat after the cache is warm', async () => {
      const provider = createLocalEmbedder({ loader });
      await provider.warmup?.();
      await provider.warmup?.();
      await provider.embed('x');
      expect(loader).toHaveBeenCalledTimes(1);
      expect(embedFn).toHaveBeenCalledTimes(1);
    });

    it('does not consume the configured timeout', async () => {
      let resolveSlow: ((fn: EmbedFn) => void) | undefined;
      const slowLoader: LocalEmbedderLoader = () =>
        new Promise((resolve) => {
          resolveSlow = (fn: EmbedFn) => resolve({ embed: fn });
        });
      const provider = createLocalEmbedder({ loader: slowLoader, timeoutMs: 50 });
      const warmupPromise = provider.warmup?.();
      // Hold the loader past the embed timeout. Warmup should
      // not time out — it runs without the per-call wallclock.
      await new Promise((r) => setTimeout(r, 100));
      resolveSlow?.(embedFn);
      await expect(warmupPromise).resolves.toBeUndefined();
    });
  });

  describe('dispose', () => {
    it('calls the runtime dispose after init has settled', async () => {
      // Pins the ADR-0025 fix: `provider.dispose()` must reach the
      // loader-supplied `runtime.dispose` so the underlying ONNX
      // pipeline (`pipeline.dispose()` in the production loader)
      // releases its session and joins its worker threads.
      const runtimeDispose = vi.fn(async () => undefined);
      const disposingLoader: LocalEmbedderLoader = async () => ({
        embed: embedFn,
        dispose: runtimeDispose,
      });
      const provider = createLocalEmbedder({ loader: disposingLoader });
      // No init has fired yet — dispose must be a no-op.
      await provider.dispose?.();
      expect(runtimeDispose).not.toHaveBeenCalled();
      // After at least one embed (or warmup), dispose forwards.
      await provider.embed('seed');
      await provider.dispose?.();
      expect(runtimeDispose).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the runtime does not expose dispose', async () => {
      // Test fakes and any loader without persistent native
      // state can omit dispose. Must not throw.
      const provider = createLocalEmbedder({ loader });
      await provider.warmup?.();
      await provider.dispose?.();
    });

    it('is a no-op when init rejected', async () => {
      // If the loader failed, there is no runtime to dispose.
      // Calling dispose must not surface the original failure
      // again, and must not throw on its own.
      const failingLoader: LocalEmbedderLoader = async () => {
        throw new Error('cold start failed');
      };
      const provider = createLocalEmbedder({ loader: failingLoader });
      await expect(provider.embed('x')).rejects.toThrow('cold start failed');
      await expect(provider.dispose?.()).resolves.toBeUndefined();
    });
  });

  it('retries loader initialisation after a failure', async () => {
    let calls = 0;
    const flakyLoader: LocalEmbedderLoader = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('cold start failed');
      }
      return { embed: embedFn };
    };
    const provider = createLocalEmbedder({ loader: flakyLoader });
    await expect(provider.embed('first')).rejects.toThrow('cold start failed');
    const result = await provider.embed('second');
    expect(calls).toBe(2);
    expect(result).toHaveLength(DEFAULT_LOCAL_DIMENSION);
  });

  describe('maxInputBytes', () => {
    // A peer cannot OOM the embedder by submitting megabyte-long
    // content. Inputs over the cap are truncated UTF-8-safely
    // before reaching the model.
    it('truncates oversize text before passing it to the model', async () => {
      let received: string | undefined;
      const captureEmbed: EmbedFn = async (text) => {
        received = text;
        return buildVector(DEFAULT_LOCAL_DIMENSION, 0);
      };
      const captureLoader: LocalEmbedderLoader = async () => ({ embed: captureEmbed });
      const provider = createLocalEmbedder({ loader: captureLoader, maxInputBytes: 16 });
      await provider.embed('a'.repeat(64));
      expect(received).toBe('a'.repeat(16));
    });

    it('passes shorter inputs through unchanged', async () => {
      let received: string | undefined;
      const captureEmbed: EmbedFn = async (text) => {
        received = text;
        return buildVector(DEFAULT_LOCAL_DIMENSION, 0);
      };
      const captureLoader: LocalEmbedderLoader = async () => ({ embed: captureEmbed });
      const provider = createLocalEmbedder({ loader: captureLoader, maxInputBytes: 32 });
      await provider.embed('hello');
      expect(received).toBe('hello');
    });

    it('truncates on a UTF-8 boundary even for multi-byte input', async () => {
      let received: string | undefined;
      const captureEmbed: EmbedFn = async (text) => {
        received = text;
        return buildVector(DEFAULT_LOCAL_DIMENSION, 0);
      };
      const captureLoader: LocalEmbedderLoader = async () => ({ embed: captureEmbed });
      // 'é' is 2 UTF-8 bytes. Cap of 3 bytes leaves space for one
      // 'a' + 'é' = 3 bytes, with no partial codepoint.
      const provider = createLocalEmbedder({ loader: captureLoader, maxInputBytes: 3 });
      await provider.embed('aééé');
      // The decoder drops any partial sequence; the result is
      // every full codepoint that fit.
      expect(Buffer.byteLength(received ?? '', 'utf8')).toBeLessThanOrEqual(3);
    });
  });

  describe('timeoutMs', () => {
    it('rejects when a single embed exceeds the cap', async () => {
      const slowEmbed: EmbedFn = () =>
        new Promise<readonly number[]>((resolve) => {
          setTimeout(() => resolve(buildVector(DEFAULT_LOCAL_DIMENSION, 0)), 200);
        });
      const slowLoader: LocalEmbedderLoader = async () => ({ embed: slowEmbed });
      const provider = createLocalEmbedder({ loader: slowLoader, timeoutMs: 50 });
      await expect(provider.embed('x')).rejects.toThrow(/timed out after 50ms/u);
    });

    it('does not affect fast embeds', async () => {
      const provider = createLocalEmbedder({ loader, timeoutMs: 5_000 });
      const v = await provider.embed('x');
      expect(v).toHaveLength(DEFAULT_LOCAL_DIMENSION);
    });

    it('applies the timeout to the whole batch as one unit', async () => {
      // The batch path takes a single wallclock cap — it's one
      // runtime call from the embedder's perspective, not N.
      const slowBatch: EmbedBatchFn = (texts) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(texts.map(() => buildVector(DEFAULT_LOCAL_DIMENSION, 0))), 200);
        });
      const slowLoader: LocalEmbedderLoader = async () => ({
        embed: embedFn,
        embedBatch: slowBatch,
      });
      const provider = createLocalEmbedder({ loader: slowLoader, timeoutMs: 50 });
      await expect(provider.embedBatch!(['a', 'b', 'c'])).rejects.toThrow(
        /batch\[3\] timed out after 50ms/u,
      );
    });
  });

  describe('embedBatch', () => {
    it('uses the loader-provided batch fn when available (fast path)', async () => {
      // Each row encodes its input index so the test can assert
      // order preservation through the slice.
      const batchFn = vi.fn(async (texts: readonly string[]) =>
        texts.map((_, i) => buildVector(DEFAULT_LOCAL_DIMENSION, i * 0.01)),
      );
      const batchLoader: LocalEmbedderLoader = async () => ({
        embed: embedFn,
        embedBatch: batchFn,
      });
      const provider = createLocalEmbedder({ loader: batchLoader });
      const out = await provider.embedBatch!(['a', 'b', 'c']);

      expect(batchFn).toHaveBeenCalledTimes(1);
      expect(batchFn).toHaveBeenCalledWith(['a', 'b', 'c']);
      // Single-call path must NOT have been used when the batch fn
      // is available — that's the whole point of the fast path.
      expect(embedFn).not.toHaveBeenCalled();
      expect(out).toHaveLength(3);
      expect(out[0]![0]).toBeCloseTo(0);
      expect(out[1]![0]).toBeCloseTo(0.01);
      expect(out[2]![0]).toBeCloseTo(0.02);
    });

    it('falls back to sequential embed when the loader omits embedBatch', async () => {
      // The default `loader` fixture returns only { embed }.
      const provider = createLocalEmbedder({ loader });
      const out = await provider.embedBatch!(['a', 'b', 'c']);
      expect(embedFn).toHaveBeenCalledTimes(3);
      expect(out).toHaveLength(3);
    });

    it('returns [] for empty input without invoking the loader', async () => {
      const batchFn = vi.fn(async () => [] as readonly (readonly number[])[]);
      const batchLoader = vi.fn(async () => ({
        embed: embedFn,
        embedBatch: batchFn,
      })) as ReturnType<typeof vi.fn> & LocalEmbedderLoader;
      const provider = createLocalEmbedder({ loader: batchLoader });
      const out = await provider.embedBatch!([]);
      expect(out).toEqual([]);
      // Empty input short-circuits before the runtime is touched.
      expect(batchLoader).not.toHaveBeenCalled();
      expect(batchFn).not.toHaveBeenCalled();
    });

    it('rejects when the batch runtime returns the wrong row count', async () => {
      // A misbehaving runtime that drops a row would corrupt the
      // caller's input↔output alignment. Better to fail loud.
      const dropsRow: EmbedBatchFn = async (texts) =>
        texts.slice(0, texts.length - 1).map(() => buildVector(DEFAULT_LOCAL_DIMENSION, 0));
      const badLoader: LocalEmbedderLoader = async () => ({
        embed: embedFn,
        embedBatch: dropsRow,
      });
      const provider = createLocalEmbedder({ loader: badLoader });
      await expect(provider.embedBatch!(['a', 'b', 'c'])).rejects.toThrow(
        /returned 2 vectors for 3 inputs/u,
      );
    });

    it('validates each row in the batch against the configured dimension', async () => {
      const wrongDim: EmbedBatchFn = async (texts) => texts.map(() => buildVector(10, 0));
      const wrongLoader: LocalEmbedderLoader = async () => ({
        embed: embedFn,
        embedBatch: wrongDim,
      });
      const provider = createLocalEmbedder({ loader: wrongLoader });
      // `EmbeddingProvider.embedBatch` is optional in the core
      // contract but always provided by `createLocalEmbedder`.
      await expect(provider.embedBatch!(['a'])).rejects.toThrow(/length 10, expected 768/u);
    });

    it('truncates oversize inputs on the batch path before the runtime sees them', async () => {
      // The maxInputBytes guard applies to every row, batch or not.
      let captured: readonly string[] | undefined;
      const captureBatch: EmbedBatchFn = async (texts) => {
        captured = texts;
        return texts.map(() => buildVector(DEFAULT_LOCAL_DIMENSION, 0));
      };
      const captureLoader: LocalEmbedderLoader = async () => ({
        embed: embedFn,
        embedBatch: captureBatch,
      });
      const provider = createLocalEmbedder({
        loader: captureLoader,
        maxInputBytes: 4,
      });
      await provider.embedBatch!(['short', 'this is too long', 'fits']);
      expect(captured).toEqual(['shor', 'this', 'fits']);
    });
  });
});
