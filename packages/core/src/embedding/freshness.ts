// Single source of truth for "does this memory's stored
// embedding match the active embedder?" — the same comparison
// `reembedAll` uses to decide what to re-embed, and the one the
// wire-level `embeddingStatus` projection uses to distinguish
// `'present'` (fresh) from `'stale'` (model / dimension drift).
//
// Keeping the check here means a future model / dimension
// migration only has one place to teach about (rather than the
// bulk re-embed driver and the read-time projection drifting
// from each other and producing contradictory answers about
// what `embedding.rebuild` would target).

import type { Memory } from '@psraghuveer/memento-schema';

/**
 * The minimum information needed to test an embedding's
 * freshness against an active embedder. A subset of
 * `EmbeddingProvider` so callers that hold a `{model, dimension}`
 * tuple (e.g. `MemoryCommandDeps.configuredEmbedder`) and callers
 * that hold a full provider can both use this helper.
 */
export interface EmbedderIdentity {
  readonly model: string;
  readonly dimension: number;
}

/**
 * Returns `true` iff `embedding` is non-null AND its `model` /
 * `dimension` match `configured`. A non-null embedding row
 * whose model or dimension differs from the active provider is
 * treated as **stale** (`false`) — that's the row
 * `embedding.rebuild` would re-embed.
 *
 * When `configured === undefined` (no host embedder wired —
 * e.g. a test fixture, the doc generator, or a process that
 * adopted a db without an embedder), the staleness check has
 * no comparison point, so we fall back to "any non-null
 * embedding is fresh." That's the conservative choice — hosts
 * without an active embedder were treating these rows as
 * `'present'` before this helper existed, and the alternative
 * (treating every embedded row as `'stale'` in those hosts)
 * would be a behaviour change without a corresponding
 * remediation path (there's no provider to rebuild against).
 */
export function isEmbeddingFresh(
  embedding: Memory['embedding'],
  configured: EmbedderIdentity | undefined,
): boolean {
  if (embedding === null) return false;
  if (configured === undefined) return true;
  return embedding.model === configured.model && embedding.dimension === configured.dimension;
}
