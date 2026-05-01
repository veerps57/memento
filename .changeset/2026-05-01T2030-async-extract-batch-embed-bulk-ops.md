---
'@psraghuveer/memento-schema': minor
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-embedder-local': minor
---

perf: async extraction, batched embeddings, and bulk repository operations (ADR-0017)

### `@psraghuveer/memento-schema`

- New config key `extraction.processing` (`'sync' | 'async'`, default `'async'`) controls whether `memory.extract` blocks until completion or returns a receipt immediately.
- New config keys `embedding.rebuild.defaultBatchSize` and `embedding.rebuild.maxBatchSize` for tuning bulk re-embedding.

### `@psraghuveer/memento-core`

- **Batched embeddings:** `EmbeddingProvider` gains an optional `embedBatch(texts)` method. `embedBatchFallback` helper delegates to it when present, falling back to sequential `embed()` calls. `reembedAll` uses batch-first with graceful per-row fallback on batch failure.
- **Async extract processing:** `memory.extract` in `async` mode (now the default) returns a `{ batchId, status: 'accepted' }` receipt immediately and processes candidates in the background. Sync mode pre-computes all embeddings via `embedBatch` upfront instead of per-candidate.
- **Bulk repository methods:** `forgetBatch`, `archiveBatch`, and `confirmBatch` wrap all transitions in a single SQLite transaction. `archive_many` parallelises its 3 `listIdsForBulk` queries via `Promise.all`.

### `@psraghuveer/memento-embedder-local`

- Implements `embedBatch` on the local ONNX embedder (sequential under the hood until transformers.js adds batch inference).
