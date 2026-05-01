# ADR-0017: Async Extraction, Batched Embeddings, and Bulk Repository Operations

- **Status:** Accepted
- **Date:** 2026-05-01
- **Deciders:** Raghu + Claude
- **Tags:** performance, extraction, embedding, bulk-ops

## Context

A performance audit of all command handlers revealed three classes of unnecessary blocking:

1. **`memory.extract` blocks the caller on per-candidate sequential processing.** Each candidate requires an embedding forward pass (~50–200ms with the local ONNX model), a vector similarity search, an optional hydration read, and a write or supersede. For a batch of 10 candidates, the caller waits 1–4 seconds for results it cannot act on mid-conversation. The assistant dumps "here's what I noticed" and moves on — it does not branch on which candidates were skipped vs written.

2. **`EmbeddingProvider` has no batch interface.** The single `embed(text: string)` method forces both `memory.extract` and `embedding.rebuild` into sequential loops. The underlying ONNX runtime supports batched inference natively; calling it 10 times sequentially wastes GPU/CPU scheduling overhead that a single batched call would amortise.

3. **Bulk mutation commands (`forget_many`, `archive_many`, `confirm_many`) run sequential per-row `await` loops.** Each row is a separate SQLite transaction round-trip. Additionally, `archive_many` issues 3 sequential `listIdsForBulk` queries (one per source status) that are independent and could run concurrently.

None of these are correctness bugs. All are latency taxes the user pays for no visible benefit.

## Decision

Ship three changes together:

### 1. `EmbeddingProvider.embedBatch` — optional batch method with sequential fallback

Add an optional `embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>` method to the `EmbeddingProvider` interface. When present, callers use it; when absent, a helper function falls back to sequential `embed()` calls. `@psraghuveer/memento-embedder-local` implements native batching via the transformers.js pipeline's built-in batch support.

This is the foundational change — everything else builds on it.

### 2. `memory.extract` — sync acknowledgment, async processing

Add a config key `extraction.processing` with values `'sync' | 'async'` (default: `'async'`). The caller — an LLM assistant — fires `memory.extract` as a fire-and-forget side-effect and never branches on which candidates were written vs skipped, so blocking on the full response adds latency for no benefit. Callers that do need the full breakdown can set `extraction.processing = 'sync'`.

- **`sync` mode (current behavior):** process all candidates and return the full `written/skipped/superseded` breakdown. Uses `embedBatch` to pre-compute all vectors upfront instead of embedding per-candidate.
- **`async` mode:** validate the batch, return a receipt immediately (`{ batchId, candidateCount, status: 'accepted' }`), process in the background. A new `memory.extract_status` command (read-only) lets the caller poll for results.
- **Dry-run is always sync** regardless of mode — the caller genuinely needs the preview.

Even in sync mode, the `embedBatch` change eliminates the sequential embedding bottleneck, which is the dominant cost.

### 3. Batch repository methods for bulk mutations

Add transactional batch methods to `MemoryRepository`:

- `forgetBatch(ids: MemoryId[], reason, ctx): Promise<BulkResult>` — single transaction, strict all-or-nothing. A single non-active row rolls back the entire batch.
- `archiveBatch(ids: MemoryId[], ctx): Promise<BulkResult>` — single transaction. Already-archived rows are silently skipped (idempotent).
- `confirmBatch(ids: MemoryId[], ctx): Promise<{ applied, skippedIds }>` — single transaction. Non-active or missing rows are skipped and returned in `skippedIds`, allowing partial success (unlike `forgetBatch`'s strict semantics).

The command handlers (`forget_many`, `archive_many`, `confirm_many`) switch to these batch methods. `forgetBatch` enforces all-or-nothing; `archiveBatch` and `confirmBatch` are lenient (skip rows already in the target state or not eligible). The dry-run path is unaffected.

Additionally, `archive_many`'s 3 `listIdsForBulk` calls are parallelised via `Promise.all`.

## Consequences

### Positive

- `memory.extract` with 10 candidates drops from ~2–4s to ~0.5–1s in sync mode (batch embed + parallel dedup), or ~50ms in async mode (just validation + queue).
- `embedding.rebuild` throughput improves proportionally to the batch size.
- Bulk mutations go from O(n) SQLite transactions to O(1).
- `archive_many` listing phase drops from 3 sequential queries to 1 wall-clock round-trip.
- Async extract unblocks the MCP response for the most latency-sensitive path.

### Negative

- `EmbeddingProvider` interface grows by one optional method — all existing implementations continue to work via the sequential fallback.
- Async mode introduces a new `memory.extract_status` command and a background processing concern (in-process task queue, not a separate worker).
- Batch repo methods change partial-failure semantics: `forgetBatch` is strict all-or-nothing; `archiveBatch` and `confirmBatch` are lenient (skip ineligible rows). Callers that relied on per-row progress details need updating. The dry-run preview mitigates this: callers discover problems before committing.
- One new config key (`extraction.processing`).

### Risks

- Batch embed with a large batch could spike memory usage — mitigated by the existing `extraction.maxCandidatesPerCall` cap (default 20) and `embedding.rebuild`'s existing `batchSize` parameter.
- Async mode needs a way to surface background errors — mitigated by `memory.extract_status` polling and `memory.events` audit trail (extracted memories emit `created` events).
- `forgetBatch`'s strict all-or-nothing could roll back more work on a single bad row — mitigated by the fact that the most common failure mode (status already transitioned by a concurrent writer) is exactly the case where partial progress was misleading anyway. `archiveBatch` and `confirmBatch` mitigate this further by silently skipping ineligible rows.

## Alternatives considered

### Alternative A: Only add embedBatch, keep everything else sync

- Attractive: smallest change, biggest single win (batch embed dominates the latency).
- Rejected: misses the bulk repo and async extract opportunities. The bulk sequential loops are a design smell regardless of current latency, and async extract is the right long-term contract for a fire-and-forget operation.

### Alternative B: Async extract via MCP notifications

- Attractive: MCP has a notification mechanism; the server could push results when done.
- Rejected: MCP notifications are server→client and not all clients handle them. Polling via `extract_status` is universally compatible and lets the caller decide when (or whether) to check.

### Alternative C: Worker thread / separate process for async extract

- Attractive: true isolation, no event-loop blocking.
- Rejected: over-engineered for v1. The ONNX runtime already runs inference off the main thread internally. An in-process task queue (Promise-based) is sufficient and avoids IPC complexity. Worker threads can be added later if profiling shows main-thread contention.

### Alternative D: Batch repo methods with partial-failure reporting

- Attractive: preserves the current stop-on-first-error semantics.
- Rejected: partial-failure reporting in a sequential loop is fundamentally at odds with transactional batching. The dry-run path already lets callers preview the full set before committing. All-or-nothing is simpler, more predictable, and what most callers actually want.

## Validation against the four principles

1. **First principles.** Each change exists because we measured the blocking cost and proved the caller doesn't need to wait. `embedBatch` exists because the ONNX runtime supports it natively and we're leaving performance on the table. Async extract exists because the caller cannot act on the results. Batch repo methods exist because N transactions for N rows is an accidental complexity.
2. **Modular.** `embedBatch` is optional on the provider interface — existing implementations work unchanged. Async extract is behind a config flag. Batch repo methods are additive — the per-row methods remain for single-item commands.
3. **Extensible.** `embedBatch` makes future providers (cloud APIs with native batch endpoints) a natural fit. Async extract's in-process queue can be promoted to a worker thread without changing the command contract. Batch repo methods can gain savepoint-based partial-failure reporting later if needed.
4. **Config-driven.** `extraction.processing` controls sync vs async. Existing config keys (`extraction.maxCandidatesPerCall`, `embedding.rebuild.batchSize`) cap batch sizes.

## References

- ADR-0006: Local embeddings only in v1 (provider interface)
- ADR-0014: Bulk-destructive operations (forget_many / archive_many)
- ADR-0016: Assisted Extraction and Context Injection (memory.extract)
