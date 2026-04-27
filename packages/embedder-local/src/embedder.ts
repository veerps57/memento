// createLocalEmbedder — an `EmbeddingProvider` backed by
// transformers.js. Lazy: importing this module does not load
// the runtime or download the model. The first `embed()` call
// triggers a single-flight initialisation; concurrent calls
// share the same in-flight promise.
//
// Defaults track ADR 0006 and are sourced from the canonical
// config registry (`@psraghuveer/memento-schema/config`) so that the
// embedder package can never drift from the documented
// `embedder.local.model` / `embedder.local.dimension` defaults.
//
// The factory accepts an optional `loader`. The default loader
// performs `import('@huggingface/transformers')` at first use
// and constructs a `feature-extraction` pipeline with mean
// pooling and L2-normalisation, which is the configuration the
// `bge-*` family of models is trained for. Tests inject a fake
// loader so the suite never downloads a model.

import type { EmbeddingProvider } from '@psraghuveer/memento-core';
import { CONFIG_KEYS } from '@psraghuveer/memento-schema';

/**
 * The default model identifier surfaced as `provider.model`.
 * Sourced from the `embedder.local.model` config key so the
 * registry is the single source of truth.
 */
export const DEFAULT_LOCAL_MODEL = CONFIG_KEYS['embedder.local.model'].default;

/**
 * The default vector dimension surfaced as `provider.dimension`.
 * Sourced from the `embedder.local.dimension` config key.
 */
export const DEFAULT_LOCAL_DIMENSION = CONFIG_KEYS['embedder.local.dimension'].default;

/**
 * The runtime side of a loader: given a piece of text, returns
 * the embedding vector. Plain arrays so the result is trivially
 * serialisable and so the shape contract is decoupled from any
 * transformers.js typed-array.
 */
export type EmbedFn = (text: string) => Promise<readonly number[]>;

/**
 * Pluggable initialiser. Receives the resolved model id and the
 * resolved cache directory (when set), and returns a function
 * that performs a single embedding.
 *
 * The default implementation (`createDefaultLoader`) wraps
 * `@huggingface/transformers`. Tests pass a fake to keep the
 * suite hermetic.
 */
export type LocalEmbedderLoader = (
  model: string,
  options: LocalEmbedderLoaderContext,
) => Promise<EmbedFn>;

export interface LocalEmbedderLoaderContext {
  readonly cacheDir?: string;
}

export interface LocalEmbedderOptions {
  /** Override the model id. Stored as `provider.model`. */
  readonly model?: string;
  /**
   * Override the expected vector dimension. The factory
   * validates every produced vector against this value and
   * throws on mismatch — protection against a misconfigured
   * model id silently emitting the wrong shape.
   */
  readonly dimension?: number;
  /**
   * Cache directory for the underlying runtime. Forwarded to
   * the loader; the default loader sets `transformers.env.cacheDir`.
   */
  readonly cacheDir?: string;
  /** DI hook. Defaults to `createDefaultLoader()`. */
  readonly loader?: LocalEmbedderLoader;
}

/**
 * Build a local embedder. Construction is cheap and synchronous;
 * the heavy work (runtime import, model download, pipeline
 * construction) is deferred until the first `embed()` call.
 */
export function createLocalEmbedder(options: LocalEmbedderOptions = {}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_LOCAL_MODEL;
  const dimension = options.dimension ?? DEFAULT_LOCAL_DIMENSION;
  const loader = options.loader ?? createDefaultLoader();
  const loaderContext: LocalEmbedderLoaderContext =
    options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {};

  // Single-flight init: every concurrent `embed` call awaits the
  // same promise, so the model is loaded exactly once even under
  // a burst. We cache the *promise*, not the resolved fn, so a
  // failed first init can be retried by replacing the cache.
  let pending: Promise<EmbedFn> | undefined;

  const ensureReady = (): Promise<EmbedFn> => {
    if (pending === undefined) {
      const attempt = loader(model, loaderContext);
      // If the loader rejects, clear the cache so the next call
      // retries instead of permanently surfacing the same error.
      attempt.catch(() => {
        if (pending === attempt) {
          pending = undefined;
        }
      });
      pending = attempt;
    }
    return pending;
  };

  return {
    model,
    dimension,
    async embed(text: string): Promise<readonly number[]> {
      const embedFn = await ensureReady();
      const vector = await embedFn(text);
      if (vector.length !== dimension) {
        throw new Error(
          `Local embedder produced a vector of length ${vector.length}, expected ${dimension} (model='${model}'). The configured model and dimension are out of sync.`,
        );
      }
      return vector;
    },
  };
}

/**
 * Default loader: dynamically imports `@huggingface/transformers`
 * and builds a feature-extraction pipeline with mean pooling and
 * L2-normalisation (the configuration `bge-*` models expect for
 * cosine retrieval).
 *
 * Exported as a factory rather than a singleton so unit tests
 * can build their own variants without resetting module state.
 */
export function createDefaultLoader(): LocalEmbedderLoader {
  return async (model, { cacheDir }) => {
    let runtime: typeof import('@huggingface/transformers');
    try {
      runtime = await import('@huggingface/transformers');
    } catch (cause) {
      throw new Error(
        `Failed to load '@huggingface/transformers'. Install it as a dependency to use @psraghuveer/memento-embedder-local (e.g. \`pnpm add @huggingface/transformers\`). See packages/embedder-local/README.md for details.`,
        { cause },
      );
    }

    if (cacheDir !== undefined) {
      runtime.env.cacheDir = cacheDir;
    }

    // The `Xenova/` namespace hosts community ONNX exports of
    // common HF models. `bge-small-en-v1.5` is published there.
    const repo = `Xenova/${model}`;
    const extractor = await runtime.pipeline('feature-extraction', repo);

    return async (text: string): Promise<readonly number[]> => {
      const output = await extractor(text, {
        pooling: 'mean',
        normalize: true,
      });
      // `output.data` is a `Float32Array` from transformers.js.
      // `Array.from` materialises a plain `number[]` so we don't
      // hand a typed-array reference back to callers — keeps the
      // contract pure-JS.
      return Array.from(output.data);
    };
  };
}
