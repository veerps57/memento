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
 * Optional batched variant. The transformers.js v3 pipeline
 * accepts an array input and returns a `[batch, dim]` tensor —
 * one forward pass for the whole batch. When a loader exposes
 * this, the embedder routes its `embedBatch` calls here instead
 * of looping `embed`. The contract preserves order: result row
 * `i` is the embedding of `texts[i]`.
 */
export type EmbedBatchFn = (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;

/**
 * What a loader returns. `embed` is required; `embedBatch` is
 * optional — loaders that don't expose it cause the embedder to
 * fall back to looping `embed`, preserving the previous behaviour.
 */
export interface EmbedRuntime {
  readonly embed: EmbedFn;
  readonly embedBatch?: EmbedBatchFn;
  /**
   * Release any native handles the runtime owns — for the default
   * transformers.js loader this calls `pipeline.dispose()` which in
   * turn releases the underlying ONNX session and joins its worker
   * threads. Optional: loaders (especially test fakes) without
   * persistent native state can omit it. See {@link
   * EmbeddingProvider.dispose} for the lifecycle contract.
   */
  readonly dispose?: () => Promise<void>;
}

/**
 * Pluggable initialiser. Receives the resolved model id and the
 * resolved cache directory (when set), and returns the runtime
 * surface (single + optional batch).
 *
 * The default implementation (`createDefaultLoader`) wraps
 * `@huggingface/transformers`. Tests pass a fake to keep the
 * suite hermetic.
 */
export type LocalEmbedderLoader = (
  model: string,
  options: LocalEmbedderLoaderContext,
) => Promise<EmbedRuntime>;

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
  // a burst. We cache the *promise*, not the resolved runtime, so
  // a failed first init can be retried by replacing the cache.
  let pending: Promise<EmbedRuntime> | undefined;

  const ensureReady = (): Promise<EmbedRuntime> => {
    if (pending === undefined) {
      const attempt = loader(model, loaderContext);
      // Mark the process as "embedder loaded" the moment the load
      // resolves. The CLI's `io.exit` reads this flag to decide
      // between `process.exit(code)` (no embedder → safe, exit code
      // preserved) and `SIGKILL` (embedder loaded → bypass the
      // better-sqlite3 + onnxruntime-node native-destructor race,
      // exit code becomes 137). The flag is intentionally set on
      // the global so the CLI doesn't have to depend on this
      // package at import-time. See ADR-0026.
      attempt.then(
        () => {
          (globalThis as { __memento_embedder_loaded?: boolean }).__memento_embedder_loaded = true;
        },
        () => {
          // If the loader rejects, clear the cache so the next call
          // retries instead of permanently surfacing the same error.
          if (pending === attempt) {
            pending = undefined;
          }
        },
      );
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
      const runtime = await ensureReady();
      return validateVector(await runEmbed(runtime.embed, text, 'single'), 'single');
    },
    async embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      if (texts.length === 0) return [];
      const runtime = await ensureReady();

      // Fast path: the loader exposes a real batched implementation.
      // transformers.js v3's feature-extraction pipeline accepts an
      // array input and returns one [batch, dim] tensor in a single
      // forward pass; the default loader uses that path. The
      // wallclock cap applies to the whole batch as a single unit
      // (callers shape the batch size — we don't reshape).
      if (runtime.embedBatch !== undefined) {
        const prepared = texts.map((t) => prepareText(t));
        const work = runtime.embedBatch(prepared);
        const label = `batch[${texts.length}]`;
        const vectors =
          timeoutMs !== undefined ? await withTimeout(work, timeoutMs, label) : await work;
        if (vectors.length !== texts.length) {
          throw new Error(
            `Local embedder batch returned ${vectors.length} vectors for ${texts.length} inputs (model='${model}'). The runtime did not preserve batch length.`,
          );
        }
        return vectors.map((v, i) => validateVector(v, `batch[${i}]`));
      }

      // Slow path: fall back to sequential `embed` calls. Preserves
      // behaviour for loaders (notably the test fixtures) that only
      // implement single-text embedding.
      const results: (readonly number[])[] = [];
      for (const text of texts) {
        const label = `batch[${results.length}]`;
        results.push(validateVector(await runEmbed(runtime.embed, text, label), label));
      }
      return results;
    },
    async warmup(): Promise<void> {
      // Drive the single-flight init so the first user-facing
      // `embed()` is not stuck behind a model download / pipeline
      // construction. We discard the resulting runtime reference
      // intentionally — `ensureReady` caches it. Timeouts and byte
      // caps deliberately do NOT apply here: warmup is fire-and-
      // forget at boot time and a partial model download must be
      // allowed to complete.
      await ensureReady();
    },
    async dispose(): Promise<void> {
      // Release the ONNX inference session and its worker threads
      // so process-exit doesn't race the native destructors. Only
      // act if a runtime was actually loaded — calling `dispose`
      // on an embedder that never embedded (or whose loader hasn't
      // settled) would force the lazy init solely to immediately
      // tear it down, which is silly and could throw on a failed
      // load. Resolving the cached promise to peek at whether init
      // started is the cheap version; we await it (the bootstrap
      // shutdown has already drained background work, so any
      // pending init has either resolved or rejected by now).
      if (pending === undefined) return;
      let runtime: EmbedRuntime;
      try {
        runtime = await pending;
      } catch {
        // The cached init rejected. Nothing native to release.
        return;
      }
      if (runtime.dispose !== undefined) {
        await runtime.dispose();
      }
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

    const embed: EmbedFn = async (text) => {
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

    // transformers.js v3's feature-extraction pipeline accepts an
    // array input and returns a single `[batch, dim]` tensor — one
    // forward pass for the whole batch instead of N. Confirmed
    // numerically equivalent to looping the single-call form (row
    // `i` matches a single call on `texts[i]`). The wallclock win
    // grows with batch size: per-call ~30–50 ms on CPU vs amortised
    // tokenisation + one inference pass for the batch.
    const embedBatch: EmbedBatchFn = async (texts) => {
      if (texts.length === 0) return [];
      // Cast through `string[]` because the runtime's pipeline
      // signature is overloaded for single + array but its TS type
      // hides the array overload behind a generic.
      const output = await extractor(texts as unknown as string, {
        pooling: 'mean',
        normalize: true,
      });
      const dims = output.dims as readonly number[] | undefined;
      const batch = dims?.[0] ?? texts.length;
      const dim = dims?.[1] ?? Math.floor(output.data.length / texts.length);
      if (batch !== texts.length) {
        throw new Error(
          `transformers.js batch output rows (${batch}) did not match input length (${texts.length}); refusing to slice and risk misalignment.`,
        );
      }
      const rows: number[][] = [];
      for (let i = 0; i < batch; i += 1) {
        rows.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
      }
      return rows;
    };

    // Release the ONNX session and its worker threads. Without
    // this, the threads stay alive after the last inference and
    // race the native-module destructors at process exit — the
    // libc++ mutex abort ADR-0025 tracks. `Pipeline.dispose()`
    // exists at runtime on every pipeline (it's mixed in via the
    // base class) but the published `.d.ts` only exposes it on a
    // handful of derived types; `FeatureExtractionPipeline` is not
    // one of them. We narrow through the library's exported
    // `Disposable` type so the cast is informative rather than
    // `any`. `Pipeline.dispose()` returns a Promise that resolves
    // when the underlying `InferenceSession.release()` completes;
    // we don't catch in the helper because the caller
    // (`MementoApp.shutdown`) wraps it.
    const dispose = async (): Promise<void> => {
      await (extractor as unknown as { dispose: () => Promise<void> }).dispose();
    };

    return { embed, embedBatch, dispose };
  };
}
