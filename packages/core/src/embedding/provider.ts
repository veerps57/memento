// EmbeddingProvider — the contract every embedder must satisfy.
//
// v1 ships exactly one implementation: `@psraghuveer/memento-embedder-local`
// (transformers.js + bge-small-en-v1.5), per ADR 0006. Cloud
// providers are deliberately a v2 concern. The interface lives
// in `@psraghuveer/memento-core` so consumers depend on the contract, not
// the implementation, and so test fakes (see
// `test/embedding/reembed.test.ts`) can satisfy it without a
// model download.
//
// Design notes:
//
// - `model` and `dimension` are surfaced as readonly properties
//   on the provider so the bulk driver (`reembedAll`) can decide
//   whether a memory's existing embedding is stale (different
//   model or dimension) without paying for a forward pass.
// - `embed` returns the raw vector. The caller (the repository)
//   stamps `createdAt` and threads the row through
//   `EmbeddingSchema` so the dimension invariant is checked once,
//   in one place.
// - The interface intentionally does NOT take a memory or any
//   memory-shaped argument. An embedder embeds text. What text
//   to embed (content, summary, both, joined) is a layer-above
//   policy decision; the bulk driver picks `content` today.

export interface EmbeddingProvider {
  /**
   * The identifier of the underlying model. Stored on every
   * embedding row so a later run can detect "the model changed"
   * with a row-level comparison. Must be a stable, non-empty
   * string; bge-small-en-v1.5 surfaces as `'bge-small-en-v1.5'`.
   */
  readonly model: string;
  /**
   * The output dimensionality of the model. Stored alongside
   * `model`; mismatches between this and a row's stored
   * `embedding.dimension` mark the row as stale.
   */
  readonly dimension: number;
  /**
   * Embed a single text. Returns a vector of length `dimension`.
   * Implementations are free to be lazy / async (the local
   * embedder downloads its model on first use). Errors should
   * propagate; the bulk driver treats a single failure as a
   * skip with reason `error`.
   */
  embed(text: string): Promise<readonly number[]>;
  /**
   * Embed multiple texts in a single batch. Returns vectors in
   * the same order as the input texts. Optional — when absent,
   * callers use {@link embedBatchFallback} which calls `embed`
   * sequentially. Implementations that support native batching
   * (e.g. transformers.js pipeline) should override this for
   * throughput.
   *
   * @since ADR-0017
   */
  embedBatch?(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/**
 * Call `provider.embedBatch` if available, otherwise fall back
 * to sequential `embed` calls. Callers should always use this
 * helper rather than checking `embedBatch` themselves — it
 * keeps the fallback in one place.
 */
export async function embedBatchFallback(
  provider: EmbeddingProvider,
  texts: readonly string[],
): Promise<readonly (readonly number[])[]> {
  if (provider.embedBatch !== undefined) {
    return provider.embedBatch(texts);
  }
  const results: (readonly number[])[] = [];
  for (const text of texts) {
    results.push(await provider.embed(text));
  }
  return results;
}
