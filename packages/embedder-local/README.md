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
    // cacheDir: undefined, // honours transformers.js default
  }),
});
```

The factory returns an `EmbeddingProvider` whose `model` and `dimension` are surfaced synchronously, so the bulk re-embed driver can detect stale rows without paying for a forward pass.

## Defaults

The defaults below come from the canonical config registry — `embedder.local.model` and `embedder.local.dimension` in [`@psraghuveer/memento-schema/config-keys`](../schema/src/config-keys.ts). Both keys are immutable at runtime: changing them mid-session would silently mix incompatible vector spaces. Operators flip them at startup and run `embedding rebuild` to migrate stored vectors (ADR 0006, Rule 14).

| Option      | Default                 | Notes                                                                                                       |
| :---------- | :---------------------- | :---------------------------------------------------------------------------------------------------------- |
| `model`     | `bge-base-en-v1.5`      | Resolved as `Xenova/<model>` on Hugging Face. Pin a different `Xenova/*` model to swap embedders.           |
| `dimension` | `768`                   | Validated against every produced vector. Mismatch ⇒ throw. Must match the chosen `model`.                   |
| `cacheDir`  | _(runtime default)_     | Forwarded to `transformers.env.cacheDir` when set. Environmental, not a config key.                         |
| `loader`    | `createDefaultLoader()` | DI hook. Tests inject a fake to keep the suite hermetic.                                                    |

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
