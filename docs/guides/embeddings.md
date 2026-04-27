# Embeddings setup

Memento ships two retrieval arms: full-text search (FTS, always on) and vector search (off by default, gated behind `retrieval.vector.enabled`). This guide explains how to opt into the vector arm — what to install, what to expect on first run, and how to wire the embedder when embedding Memento as a library.

The architectural rationale lives in [`docs/architecture/retrieval.md`](../architecture/retrieval.md) and ADR [`0006-local-embeddings-only-in-v1.md`](../adr/0006-local-embeddings-only-in-v1.md). This document is the operator-facing companion.

## What "vector retrieval" gives you

FTS catches lexical matches: proper nouns, identifiers, exact phrases. Vector search catches paraphrases: queries whose words don't appear in the stored memory but whose meaning does. The retrieval pipeline unions both candidate sets and lets the ranker score the union — neither arm is "primary"; they cover different failure modes.

When `retrieval.vector.enabled` is `false` (the default), Memento behaves as a pure-FTS store. You get correct, fast retrieval over the literal text of every memory; you do not get paraphrase matching.

## What you need

1. The `@psraghuveer/memento-embedder-local` package and its peer dependency `@huggingface/transformers`. The peer dependency is **not** declared as a hard dependency — the runtime is large (~100 MB once the model is cached) and only relevant when you opt in.
2. The flag flipped on: `retrieval.vector.enabled = true`. The published `memento` CLI auto-wires the embedder when this flag is set; library consumers pass `embeddingProvider` to `createMementoApp` themselves.
3. Roughly 33 MB of disk for the `bge-small-en-v1.5` ONNX model, downloaded on first use.

## Step 1: Install the embedder

**Globally installed CLI** (`npm install -g @psraghuveer/memento`):

```bash
npm install -g @psraghuveer/memento-embedder-local @huggingface/transformers
```

**`npx` users**: install the two packages into the project where `npx` runs from, or install them globally as above.

**From a clone** (contributors):

```bash
pnpm add -w @huggingface/transformers
```

`@psraghuveer/memento-embedder-local` is already a workspace package; the workspace install builds it. Adding `@huggingface/transformers` satisfies the dynamic `import('@huggingface/transformers')` inside the embedder.

If the peer is missing when an embedder code path runs, you will see:

```text
Failed to load '@huggingface/transformers'. Install it as a
dependency to use @psraghuveer/memento-embedder-local (e.g.
`pnpm add @huggingface/transformers`). See
packages/embedder-local/README.md for details.
```

## Step 2: Wire the embedder (library use only)

The `memento` CLI handles wiring automatically when `retrieval.vector.enabled` is true — see ["CLI auto-wires the local embedder"](#cli-auto-wires-the-local-embedder-when-vector-retrieval-is-enabled) below. Skip this step if you only use the CLI / MCP server.

Library consumers wire the embedder by passing `embeddingProvider` to `createMementoApp`:

```ts
import { createMementoApp } from "@psraghuveer/memento-core";
import { createLocalEmbedder } from "@psraghuveer/memento-embedder-local";

const app = await createMementoApp({
  dbPath: "/abs/path/to/memento.db",
  embeddingProvider: createLocalEmbedder(),
  // bge-small-en-v1.5, dimension 384 — both come from the
  // canonical config registry and are immutable at runtime.
});
```

`createLocalEmbedder()` returns synchronously; the underlying transformers.js pipeline is **lazy-loaded on the first call to `embed()`**. That keeps `memento serve` startup, `memento context`, and other read-only paths fast and offline-friendly.

## Step 3: Turn vector retrieval on

From the CLI:

```bash
memento config set retrieval.vector.enabled true
```

Or from a library host:

```ts
await executeCommand(
  app.registry.commands["config.set"],
  { key: "retrieval.vector.enabled", value: true },
  ctx,
);
```

The next call to `memory.search` will run both retrieval arms.

## Step 4: First-run model download

The first call to `embed()` after the flag is on will block briefly while transformers.js downloads the ONNX model from Hugging Face — roughly 33 MB. Subsequent calls reuse the cache. The cache directory follows transformers.js's default; override it via `cacheDir` on `createLocalEmbedder({ cacheDir: "/abs/path" })` if you want to keep it under your Memento data directory.

To pre-warm the cache without going through Memento:

```bash
pnpm add -w @huggingface/transformers
node --input-type=module -e "
  import { createLocalEmbedder } from '@psraghuveer/memento-embedder-local';
  const e = createLocalEmbedder();
  console.log('embedding test message...');
  const v = await e.embed('hello world');
  console.log(e.model, e.dimension, v.length, v.slice(0, 3));
"
```

## Step 5: Embedding existing memories

Memories written **before** the flag was on have no embedding. They will continue to surface via FTS but cannot be matched by paraphrase. To backfill them, run the `embedding.rebuild` command. From a host that has wired the embedder:

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
2. If the flag is `false`, keeps the probe app and returns it. The embedder is never loaded — `@huggingface/transformers` is not even resolved, so a fresh install with FTS-only usage stays lightweight.
3. If the flag is `true`, closes the probe, calls the dependency-injected `resolveEmbedder` (production default: `createRequire(import.meta.url).resolve('@psraghuveer/memento-embedder-local')` followed by a dynamic `import()`), and reopens the app with `embeddingProvider` set. The registry then includes `embedding.rebuild` and `memory.search` can use vector candidates.
4. If the flag is `true` but the peer (`@psraghuveer/memento-embedder-local`) is not installed, the helper returns a `CONFIG_ERROR` at app-open time with the install hint `npm install @psraghuveer/memento-embedder-local @huggingface/transformers`. The error surfaces immediately on `serve`/`context` startup or on the first registry-dispatched command — not deferred to the first `memory.search`.

`memento doctor` performs the same resolve check as a pre-flight diagnostic and reports it under the embedder probe.

If you only need FTS, leave `retrieval.vector.enabled` at its default (`false`) — the helper short-circuits and the CLI never touches the embedder peer.
