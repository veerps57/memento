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
  /**
   * Hard upper bound on the byte length of `text` passed to the
   * underlying tokenizer. Inputs longer than this are truncated
   * (UTF-8 boundary-safe) before the embed pass runs. Without a
   * cap, a megabyte-long input both wastes work the model
   * truncates internally and risks OOM on the tokeniser's
   * attention buffers. Hosts wire this from
   * `embedder.local.maxInputBytes`.
   */
  readonly maxInputBytes?: number;
  /**
   * Wallclock cap for a single embed call, in milliseconds.
   * The embedder rejects with a typed error after this elapses;
   * the in-flight tokenisation continues in the background but
   * its result is discarded. Hosts wire this from
   * `embedder.local.timeoutMs`.
   */
  readonly timeoutMs?: number;
  /** DI hook. Defaults to `createDefaultLoader()`. */
  readonly loader?: LocalEmbedderLoader;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without
 * splitting a multi-byte codepoint. The Buffer slice can land
 * mid-codepoint; `TextDecoder` with `fatal: false` recovers by
 * dropping the trailing partial sequence.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/**
 * Wrap a Promise in a wallclock cap. Rejects with a typed error
 * after `ms` even if `p` keeps running. The label appears in
 * the rejection message so audit logs can distinguish single
 * vs. batch timeouts.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Local embedder ${label} timed out after ${ms}ms`));
    }, ms);
    // `unref` so a pending timer does not keep the Node event
    // loop alive past the host's intended shutdown.
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
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
  const maxInputBytes = options.maxInputBytes;
  const timeoutMs = options.timeoutMs;

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

  const validateVector = (vector: readonly number[], label: string): readonly number[] => {
    if (vector.length !== dimension) {
      throw new Error(
        `Local embedder produced a vector of length ${vector.length}, expected ${dimension} (model='${model}', input='${label}'). The configured model and dimension are out of sync.`,
      );
    }
    return vector;
  };

  const prepareText = (text: string): string =>
    maxInputBytes !== undefined ? truncateToBytes(text, maxInputBytes) : text;

  const runEmbed = async (
    embedFn: EmbedFn,
    text: string,
    label: string,
  ): Promise<readonly number[]> => {
    const prepared = prepareText(text);
    const work = embedFn(prepared);
    return timeoutMs !== undefined ? withTimeout(work, timeoutMs, label) : work;
  };

  return {
    model,
    dimension,
    async embed(text: string): Promise<readonly number[]> {
      const embedFn = await ensureReady();
      return validateVector(await runEmbed(embedFn, text, 'single'), 'single');
    },
    async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      const embedFn = await ensureReady();
      // Sequential under the hood for now — the transformers.js
      // pipeline does not yet expose a true batch API for
      // feature-extraction. The win is having the interface so
      // callers batch upfront rather than interleaving embed +
      // dedup per candidate. When transformers.js adds batching,
      // this is the one place to change.
      const results: (readonly number[])[] = [];
      for (const text of texts) {
        const label = `batch[${results.length}]`;
        results.push(validateVector(await runEmbed(embedFn, text, label), label));
      }
      return results;
    },
    async warmup(): Promise<void> {
      // Drive the single-flight init so the first user-facing
      // `embed()` is not stuck behind a model download / pipeline
      // construction. We discard the resulting `EmbedFn` reference
      // intentionally — `ensureReady` caches it. Timeouts and byte
      // caps deliberately do NOT apply here: warmup is fire-and-
      // forget at boot time and a partial model download must be
      // allowed to complete.
      await ensureReady();
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
    // Pin `dtype: 'fp32'` to match the bge-* family's training
    // precision and silence the noisy `dtype not specified for
    // "model". Using the default dtype (fp32) for this device
    // (cpu).` warning that transformers.js emits on first call
    // when dtype is omitted. The behaviour is identical (fp32 is
    // also what the lib falls back to); we just suppress the
    // warning by being explicit. Reduce to 'q8' / 'q4' if the
    // user wants smaller-and-faster at the cost of recall.
    const extractor = await runtime.pipeline('feature-extraction', repo, { dtype: 'fp32' });

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
