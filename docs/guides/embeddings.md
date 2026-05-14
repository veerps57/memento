# Embeddings setup

Memento ships two retrieval arms: full-text search (FTS, always on) and vector search (on by default, gated behind `retrieval.vector.enabled`). This guide explains what happens out of the box, how to customise it, and how to wire the embedder when embedding Memento as a library.

The architectural rationale lives in [`docs/architecture/retrieval.md`](../architecture/retrieval.md) and ADR [`0006-local-embeddings-only-in-v1.md`](../adr/0006-local-embeddings-only-in-v1.md). This document is the operator-facing companion.

## What "vector retrieval" gives you

FTS catches lexical matches: proper nouns, identifiers, exact phrases. Vector search catches paraphrases: queries whose words don't appear in the stored memory but whose meaning does. The retrieval pipeline unions both candidate sets and lets the ranker score the union — neither arm is "primary"; they cover different failure modes.

When `retrieval.vector.enabled` is `true` (the default), both arms are active. If the embedding model has not yet been downloaded (first run) or a transient error occurs during embedding, the search pipeline degrades gracefully to FTS-only — you still get results, just without paraphrase matching until the vector arm recovers.

## What ships out of the box

`@psraghuveer/memento-embedder-local` (and its dependency `@huggingface/transformers`) ships as a regular dependency of the `@psraghuveer/memento` CLI package. When you install Memento, the embedder is already available — no extra install step required.

On first use, the embedding model (`bge-base-en-v1.5`, ~110 MB ONNX) is downloaded to a local cache directory. Subsequent calls reuse the cache. If the download fails or the model is not yet cached, the search pipeline degrades to FTS-only until the next successful embed call.

New memories are automatically embedded on write when `embedding.autoEmbed` is `true` (the default). The embedding runs fire-and-forget after the write commits — it does not block the write response. If the embedder is not yet initialised (first write after install), the embedding is skipped for that write and materialised on the next `embedding.rebuild` or the next write after the model has been downloaded.

## Latency expectations

Vector search is dominated by **query embedding** wall-clock — the time to embed the user's query string before any vector comparison happens. On the default `bge-base-en-v1.5` model, expect roughly **200–500 ms per query on a modern CPU** (Apple Silicon laptops sit at the low end of that range; older x86 servers at the higher end). The vector scan over stored memories is comparatively cheap once the query embedding is in hand — even 20k 768-dim vectors compare in tens of milliseconds.

If query latency matters more than recall on paraphrase, the smaller `bge-small-en-v1.5` (384d) cuts query-embed time by roughly a third at a modest recall cost. The trade-off is operator-only: `embedder.local.model` and `embedder.local.dimension` are immutable at runtime (Rule 14 — model migration must be deliberate), so `memento config set` rejects either with `IMMUTABLE`. Library hosts switch the model by passing `configOverrides` to `createMementoApp`:

```ts
import { createMementoApp } from "@psraghuveer/memento-core";

const app = await createMementoApp({
  dbPath: "/abs/path/to/memento.db",
  configOverrides: {
    "embedder.local.model": "bge-small-en-v1.5",
    "embedder.local.dimension": 384,
  },
});

await executeCommand(
  app.registry.commands["embedding.rebuild"],
  { confirm: true },
  ctx,
); // re-embed every active memory under the new model
```

CLI users who want to experiment with a different model run a one-shot `memento store migrate` followed by an `embedding.rebuild` against a programmatic app instance — the CLI surface itself does not expose a way to override the model without library code. The cost of running a different model in production should be paid deliberately.

Query embeddings are not cached today — every search call pays the full embedding cost. If your workload runs the same query string repeatedly within a session, consider opening a design proposal to add a small LRU cache.

For pure-FTS workloads where vector latency is unacceptable, see "Disabling vector retrieval" below.

## Disabling vector retrieval

If you prefer pure-FTS behavior (smaller install footprint, no model download):

```bash
memento config set retrieval.vector.enabled false
```

This disables the vector candidate arm entirely. The embedder is never loaded and no model is downloaded.

## Wiring the embedder (library use only)

The `memento` CLI handles wiring automatically when `retrieval.vector.enabled` is true — see ["CLI auto-wires the local embedder"](#cli-auto-wires-the-local-embedder-when-vector-retrieval-is-enabled) below. Skip this section if you only use the CLI / MCP server.

Library consumers wire the embedder by passing `embeddingProvider` to `createMementoApp`:

```ts
import { createMementoApp } from "@psraghuveer/memento-core";
import { createLocalEmbedder } from "@psraghuveer/memento-embedder-local";

const app = await createMementoApp({
  dbPath: "/abs/path/to/memento.db",
  embeddingProvider: createLocalEmbedder(),
  // bge-base-en-v1.5, dimension 768 — both come from the
  // canonical config registry and are immutable at runtime.
});
```

`createLocalEmbedder()` returns synchronously; the underlying transformers.js pipeline is **lazy-loaded on the first call to `embed()`**. That keeps `memento serve` startup, `memento context`, and other read-only paths fast and offline-friendly.

When the embedder is wired into Memento via `createMementoApp`, the bootstrap kicks off a fire-and-forget `provider.warmup()` after the startup backfill so the first user-facing query does not pay the lazy-init cost. The warmup races with normal request handling — it doesn't block boot, and a failure leaves the next real `embed()` to surface the underlying error. Set `embedder.local.warmupOnBoot` to `false` to keep the embedder strictly demand-loaded.

## First-run model download

The first call to `embed()` blocks briefly while transformers.js downloads the ONNX model from Hugging Face — roughly 110 MB for `bge-base-en-v1.5`. Subsequent calls reuse the cache. With `embedder.local.warmupOnBoot` on (the default), the boot-time warmup pays this download cost in the background instead of the first user-facing search. The cache directory follows transformers.js's default; override it via `cacheDir` on `createLocalEmbedder({ cacheDir: "/abs/path" })` if you want to keep it under your Memento data directory.

To pre-warm the cache without going through Memento:

```bash
node --input-type=module -e "
  import { createLocalEmbedder } from '@psraghuveer/memento-embedder-local';
  const e = createLocalEmbedder();
  console.log('embedding test message...');
  const v = await e.embed('hello world');
  console.log(e.model, e.dimension, v.length, v.slice(0, 3));
"
```

## Embedding existing memories

With `embedding.autoEmbed` on (the default), new memories are embedded automatically on write. Memories written before vector retrieval was enabled (or before the auto-embed feature was available) have no embedding. They surface via FTS but cannot be matched by paraphrase. To backfill them, run the `embedding.rebuild` command. From a host that has wired the embedder:

```ts
await executeCommand(
  app.registry.commands["embedding.rebuild"],
  { /* batch size etc., all optional */ },
  ctx,
);
```

`embedding.rebuild` is registered on the command registry **only when an `embeddingProvider` was passed to `createMementoApp`** — hosts that do not wire one get a registry where the command is absent, by design.

## Model migration (Rule 14)

If you change `embedder.local.model` or `embedder.local.dimension`, every stored vector becomes "stale" — written against a different model. Memento detects this on the first vector-search query after the change and aborts with a structured `CONFIG_ERROR`:

```text
CONFIG_ERROR: stored embedding for memory <id> was produced by
'<old-model>' (dimension <n>) but the configured provider is
'<new-model>' (dimension <m>). Run `memento embedding rebuild`
to migrate stored vectors.
```

Mixing vector spaces silently would corrupt ranking; aborting forces a deliberate migration. This is Rule 14 in [`AGENTS.md`](../../AGENTS.md).

## Backend: brute-force vs sqlite-vec

`retrieval.vector.backend` picks how cosine similarity is computed against stored embeddings. The current enum is `{auto, brute-force}`:

- **`brute-force`** (the shipping implementation): a single `SELECT` over the `memories` table per query, decoded with `EmbeddingSchema`, scored in JavaScript. Acceptable for stores in the low thousands; degrades linearly above that. Capped by `retrieval.candidate.vectorLimit` (default 200) so a pathological query cannot return tens of thousands of rows.
- **`auto`**: resolves to `brute-force` today; will resolve to `sqlite-vec` once the native backend lands. The enum will widen without breaking existing configs.

The `sqlite-vec` backend is tracked in [`KNOWN_LIMITATIONS.md`](../../KNOWN_LIMITATIONS.md).

## CLI auto-wires the local embedder when vector retrieval is enabled

The CLI's `serve`, `context`, and per-command dispatch surfaces all run through a single helper (`openAppForSurface`) that:

1. Opens the app once to read `retrieval.vector.enabled`.
2. If the flag is `false`, keeps the probe app and returns it. The embedder is never loaded.
3. If the flag is `true` (the default), closes the probe, calls the dependency-injected `resolveEmbedder` (production default: dynamic `import()` of `@psraghuveer/memento-embedder-local`), and reopens the app with `embeddingProvider` set. The registry then includes `embedding.rebuild` and `memory.search` can use vector candidates.
4. If the flag is `true` but `@psraghuveer/memento-embedder-local` could not be resolved (e.g. a broken install), the helper returns a `CONFIG_ERROR` at app-open time. The error surfaces immediately on `serve`/`context` startup — not deferred to the first `memory.search`.

`memento doctor` performs the same resolve check as a pre-flight diagnostic and reports it under the embedder probe.

If you only need FTS, set `retrieval.vector.enabled` to `false` — the helper short-circuits and the CLI never touches the embedder.
