import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCAL_DIMENSION,
  DEFAULT_LOCAL_MODEL,
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
    loader = vi.fn(async () => embedFn) as ReturnType<typeof vi.fn> & LocalEmbedderLoader;
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
    const customLoader: ReturnType<typeof vi.fn> & LocalEmbedderLoader = vi.fn(
      async () => customEmbed,
    );
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
    const wrongLoader: LocalEmbedderLoader = async () => wrongLength;
    const provider = createLocalEmbedder({ loader: wrongLoader });
    await expect(provider.embed('hi')).rejects.toThrow(/length 10, expected 768/);
  });

  it('honours an overridden dimension when validating output', async () => {
    const tinyEmbed: EmbedFn = async () => buildVector(8, 0.5);
    const tinyLoader: LocalEmbedderLoader = async () => tinyEmbed;
    const provider = createLocalEmbedder({ loader: tinyLoader, dimension: 8 });
    const v = await provider.embed('x');
    expect(v).toHaveLength(8);
  });

  it('retries loader initialisation after a failure', async () => {
    let calls = 0;
    const flakyLoader: LocalEmbedderLoader = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('cold start failed');
      }
      return embedFn;
    };
    const provider = createLocalEmbedder({ loader: flakyLoader });
    await expect(provider.embed('first')).rejects.toThrow('cold start failed');
    const result = await provider.embed('second');
    expect(calls).toBe(2);
    expect(result).toHaveLength(DEFAULT_LOCAL_DIMENSION);
  });

  describe('maxInputBytes', () => {
    // Phase 2 hardening: a peer cannot OOM the embedder by
    // submitting megabyte-long content. Inputs over the cap are
    // truncated UTF-8-safely before reaching the model.
    it('truncates oversize text before passing it to the model', async () => {
      let received: string | undefined;
      const captureEmbed: EmbedFn = async (text) => {
        received = text;
        return buildVector(DEFAULT_LOCAL_DIMENSION, 0);
      };
      const captureLoader: LocalEmbedderLoader = async () => captureEmbed;
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
      const captureLoader: LocalEmbedderLoader = async () => captureEmbed;
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
      const captureLoader: LocalEmbedderLoader = async () => captureEmbed;
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
      const slowLoader: LocalEmbedderLoader = async () => slowEmbed;
      const provider = createLocalEmbedder({ loader: slowLoader, timeoutMs: 50 });
      await expect(provider.embed('x')).rejects.toThrow(/timed out after 50ms/u);
    });

    it('does not affect fast embeds', async () => {
      const provider = createLocalEmbedder({ loader, timeoutMs: 5_000 });
      const v = await provider.embed('x');
      expect(v).toHaveLength(DEFAULT_LOCAL_DIMENSION);
    });
  });
});
