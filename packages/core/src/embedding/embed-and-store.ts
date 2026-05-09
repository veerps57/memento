// `embedAndStore` — shared "embed N memories, write the vectors"
// helper used by every install-time path that needs synchronous
// embeddings (currently `pack.install` + `importSnapshot`) plus
// the bulk recovery driver (`reembedAll`).
//
// Why a shared helper. Three call sites need the same recipe:
// take an array of `Memory` rows, run them through the provider
// in one batch (so we pay one cold-load + one inference), and
// persist the vectors via `repo.setEmbedding`. Inlining the
// recipe per call site invites drift — a partial-failure policy
// that diverges between pack.install and import is exactly the
// kind of bug the audit (PR #52) was meant to close, not
// reintroduce.
//
// Failure policy. Two layers:
//
//   - Batch fast path: `provider.embedBatch` (or its fallback
//     wrapper). One call covers all inputs. Failures here fall
//     through to the slow path so a single bad input does not
//     take down the whole batch.
//   - Slow path: per-row `provider.embed`. Per-row exceptions
//     are counted as `failed` and skipped; the rest of the
//     batch still lands.
//
// Either way the call **never throws**: callers (handler
// returning `ok(...)` after a successful write) must not be
// poisoned by an embedder hiccup. The user can always recover
// missed embeddings by running `embedding.rebuild`. We surface
// counts so callers that want to log or expose them in a
// summary can.

import type { ActorRef, Memory } from '@psraghuveer/memento-schema';

import type { MemoryRepository } from '../repository/memory-repository.js';
import type { EmbeddingProvider } from './provider.js';
import { embedBatchFallback } from './provider.js';

export interface EmbedAndStoreResult {
  /** Number of memories whose vector was successfully written. */
  readonly embedded: number;
  /** Number of memories that failed (batch + slow-path both). */
  readonly failed: number;
}

/**
 * Embed `memories` via `provider` and persist each vector via
 * `repo.setEmbedding`, attributing the writes to `actor`.
 *
 * Empty input is a no-op (returns `{embedded: 0, failed: 0}`
 * without touching the provider). Caller is responsible for
 * filtering out memories that should not be re-embedded (e.g.
 * already-fresh, sensitive-with-redaction-on, etc.) — this
 * helper is unconditional.
 *
 * Always resolves; never throws. See module header for the
 * partial-failure policy.
 */
export async function embedAndStore(
  memories: readonly Memory[],
  provider: EmbeddingProvider,
  repo: MemoryRepository,
  actor: ActorRef,
): Promise<EmbedAndStoreResult> {
  if (memories.length === 0) {
    return { embedded: 0, failed: 0 };
  }

  let embedded = 0;
  let failed = 0;

  // Fast path: one batch call.
  let vectors: readonly (readonly number[])[] | null = null;
  try {
    vectors = await embedBatchFallback(
      provider,
      memories.map((m) => m.content),
    );
  } catch {
    // Batch threw — fall through to the slow path so one bad
    // input does not poison the rest of the batch.
  }

  if (vectors !== null) {
    for (let i = 0; i < memories.length; i += 1) {
      const memory = memories[i];
      const vector = vectors[i];
      if (memory === undefined || vector === undefined) {
        failed += 1;
        continue;
      }
      try {
        await repo.setEmbedding(
          memory.id,
          { model: provider.model, dimension: provider.dimension, vector },
          { actor },
        );
        embedded += 1;
      } catch {
        // setEmbedding can fail for a stale-row reason
        // (memory got forgotten between writeMany and here)
        // or a transient DB issue. Either way, count and
        // continue — rebuild can retry.
        failed += 1;
      }
    }
    return { embedded, failed };
  }

  // Slow path: per-row embed.
  for (const memory of memories) {
    try {
      const vector = await provider.embed(memory.content);
      await repo.setEmbedding(
        memory.id,
        { model: provider.model, dimension: provider.dimension, vector },
        { actor },
      );
      embedded += 1;
    } catch {
      failed += 1;
    }
  }
  return { embedded, failed };
}
