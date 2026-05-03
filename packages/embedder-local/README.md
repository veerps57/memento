# @psraghuveer/memento-embedder-local

Local-only `EmbeddingProvider` implementation backed by [transformers.js](https://github.com/huggingface/transformers.js) using `bge-base-en-v1.5`.

Lazy-loaded: importing this module does **not** download or initialise the model. The first call to `embed()` does. This keeps `npx memento --version` and other read-only paths fast and offline.

This is the only embedder shipped in v1 — see ADR [0006 — Local embeddings only in v1](../../docs/adr/0006-local-embeddings-only-in-v1.md).

## Install

This package ships as a regular dependency of `@psraghuveer/memento` (the CLI). `@huggingface/transformers` is declared as a dependency of this package. No additional install step is needed for CLI users.

For standalone library use:

```bash
pnpm add @psraghuveer/memento-embedder-local
```

If `embed()` is called without `@huggingface/transformers` on the resolution path, the dynamic `import()` fails and `createLocalEmbedder` surfaces a friendly error pointing back to this README.

## Usage

```ts
import { createLocalEmbedder } from "@psraghuveer/memento-embedder-local";
import { createMementoApp } from "@psraghuveer/memento-core";

const app = await createMementoApp({
  dbPath: "./memento.db",
  embeddingProvider: createLocalEmbedder({
    // Optional. Defaults shown.
    // model: 'bge-base-en-v1.5',
    // dimension: 768,
    // cacheDir: '/path/to/cache', // when undefined, the CLI resolves to $XDG_CACHE_HOME/memento/models
    // maxInputBytes: 32_768,      // UTF-8-safe truncation before tokenisation
    // timeoutMs: 10_000,          // wallclock cap on a single embed call
  }),
});
```

The factory returns an `EmbeddingProvider` whose `model` and `dimension` are surfaced synchronously, so the bulk re-embed driver can detect stale rows without paying for a forward pass.

## Defaults

The defaults below come from the canonical config registry in [`@psraghuveer/memento-schema/config-keys`](../schema/src/config-keys.ts). Every `embedder.local.*` key is immutable at runtime: changing the model or dimension mid-session would silently mix incompatible vector spaces, and the input cap / timeout / cache directory shape resource accounting and disk layout that should not flip under a running process. Operators flip them at startup and run `embedding rebuild` to migrate stored vectors (ADR 0006, Rule 14).

| Option          | Config key                      | Default                                            | Notes                                                                                                                                                                                                       |
| :-------------- | :------------------------------ | :------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`         | `embedder.local.model`          | `bge-base-en-v1.5`                                 | Resolved as `Xenova/<model>` on Hugging Face. Pin a different `Xenova/*` model to swap embedders.                                                                                                            |
| `dimension`     | `embedder.local.dimension`      | `768`                                              | Validated against every produced vector. Mismatch ⇒ throw. Must match the chosen `model`.                                                                                                                    |
| `maxInputBytes` | `embedder.local.maxInputBytes`  | `32_768`                                           | UTF-8-safe truncation cap. Inputs above this are truncated before tokenisation; the model's context window is bounded anyway, and this caps the worst-case attention-buffer allocation.                       |
| `timeoutMs`     | `embedder.local.timeoutMs`      | `10_000`                                           | Wallclock cap on a single `embed` call. Times out via `Promise.race`; auto-embed swallows the rejection and falls back to "memory written without a vector" (recoverable via `embedding rebuild`).            |
| `cacheDir`      | `embedder.local.cacheDir`       | `null` → `$XDG_CACHE_HOME/memento/models`          | The CLI resolves the `null` default to a per-user XDG path so the model cache is persistent and owner-private, instead of landing inside `node_modules/.../@huggingface/transformers/.cache/`.               |
| `loader`        | _(no config key — DI only)_     | `createDefaultLoader()`                            | DI hook. Tests inject a fake to keep the suite hermetic.                                                                                                                                                    |

## Behaviour

- **Single-flight initialisation.** Concurrent `embed()` calls share one in-flight load promise; the runtime is imported and the pipeline is built exactly once per provider.
- **Retry after failure.** A failing first `embed()` clears the cached promise so the next call attempts a fresh load.
- **Mean pooling + L2 normalise.** The default loader builds the `feature-extraction` pipeline with `pooling: 'mean'` and `normalize: true`, which is the configuration `bge-base-en-v1.5` is trained for. Cosine retrieval over the produced vectors is correct without further normalisation downstream.
- **Plain-array output.** `embed()` returns a `readonly number[]`, not a `Float32Array`. Callers never see a typed-array reference.

## Testing

The vitest suite for this package is hermetic by design — it injects a fake loader and never downloads a model. The default loader is exercised by the manual smoke check below; running it in CI would download ~110 MB on every run.

```bash
# manual smoke check
node --input-type=module -e "
  import { createLocalEmbedder } from '@psraghuveer/memento-embedder-local';
  const e = createLocalEmbedder();
  const v = await e.embed('hello world');
  console.log(e.model, e.dimension, v.length, v.slice(0, 3));
"
```
