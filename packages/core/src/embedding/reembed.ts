// reembedAll — bulk re-embedding driver.
//
// Walks the active memory corpus, identifies rows whose
// embedding is missing or stale (different `model` or
// `dimension` from the supplied provider), and writes a fresh
// embedding for each via `MemoryRepository.setEmbedding`. Each
// row is its own transaction (delegated to the repo) so a
// failure mid-corpus leaves a consistent on-disk state and a
// re-run picks up where the previous run left off.
//
// Embedding strategy (ADR-0017 §1): two-path with graceful
// degradation.
//   Fast path — `embedBatchFallback` succeeds: all stale texts
//   are embedded in one call, then each vector is written
//   individually.
//   Slow path — batch throws: the driver retries each stale
//   memory via `provider.embed()` one at a time, catching
//   per-row failures as error skips. A single bad input
//   doesn't take down the entire batch.
//
// This powers the `memento embeddings rebuild` CLI command
// (wired in #11). Like `detectConflicts` (#9), it is a
// standalone callable — there is no automatic post-write
// trigger inside `MemoryRepository.write`. A server / hook
// composes the two.
//
// Stale detection is row-level and conservative: any difference
// in `model` or `dimension` triggers a re-embed. Vector content
// is never compared (bge produces near-identical but not
// bit-exact vectors across hardware; comparing them would
// produce false positives).

import type { ActorRef, Memory, MemoryId } from '@psraghuveer/memento-schema';
import { CONFIG_KEYS } from '@psraghuveer/memento-schema';

import type { MemoryRepository } from '../repository/memory-repository.js';
import type { EmbeddingProvider } from './provider.js';
import { embedBatchFallback } from './provider.js';

const DEFAULT_BATCH_SIZE = CONFIG_KEYS['embedding.rebuild.defaultBatchSize'].default;
const MAX_BATCH_SIZE = CONFIG_KEYS['embedding.rebuild.maxBatchSize'].default;

export interface ReembedOptions {
  readonly actor: ActorRef;
  /**
   * Cap on the number of memories scanned per call. Defaults to
   * `100`; max `1000`. Callers running large rebuilds should
   * page by invoking `reembedAll` repeatedly with the same
   * options — each call processes the next chunk of stale
   * candidates, so progress is monotonic. (List ordering is
   * `last_confirmed_at desc, id desc`, but stale rows surface
   * each pass until they get fresh embeddings.)
   */
  readonly batchSize?: number;
  /**
   * If `true`, also re-embed memories whose stored embedding
   * already matches `provider.model` and `provider.dimension`.
   * Default `false` — callers don't pay for redundant forward
   * passes on a clean corpus.
   */
  readonly force?: boolean;
  /**
   * If `true`, widen the scan beyond `active` to also include
   * `forgotten` and `archived` memories. Default `false` —
   * active-only matches the historical bulk-rebuild scope and
   * keeps boot-time backfill cheap. Operators flip this when
   * they want vector retrieval over a status the caller opted
   * into via `includeStatuses` (audit forensics, debug
   * tooling). The single-row `MemoryRepository.setEmbedding`
   * accepts all three statuses regardless; this flag is only
   * about which rows the bulk driver scans.
   */
  readonly includeNonActive?: boolean;
}

export interface ReembedSkip {
  readonly id: MemoryId;
  readonly reason: 'up-to-date' | 'error';
  readonly error?: Error;
}

export interface ReembedResult {
  readonly scanned: number;
  readonly embedded: readonly MemoryId[];
  readonly skipped: readonly ReembedSkip[];
}

export async function reembedAll(
  repo: MemoryRepository,
  provider: EmbeddingProvider,
  options: ReembedOptions,
): Promise<ReembedResult> {
  const limit = clampBatchSize(options.batchSize);
  // Active-only by default. `includeNonActive` widens the scan
  // by issuing parallel `list` calls per status and merging the
  // results. The combined cap stays at `batchSize` so the bulk
  // driver doesn't accidentally fan out under the opt-in.
  let memories: Memory[];
  if (options.includeNonActive) {
    const [active, forgotten, archived] = await Promise.all([
      repo.list({ status: 'active', limit }),
      repo.list({ status: 'forgotten', limit }),
      repo.list({ status: 'archived', limit }),
    ]);
    memories = [...active, ...forgotten, ...archived].slice(0, limit);
  } else {
    memories = await repo.list({ status: 'active', limit });
  }

  const embedded: MemoryId[] = [];
  const skipped: ReembedSkip[] = [];

  // Partition into stale (need re-embed) and fresh (skip).
  const staleMemories: Memory[] = [];
  for (const memory of memories) {
    if (!options.force && isFresh(memory, provider)) {
      skipped.push({ id: memory.id, reason: 'up-to-date' });
    } else {
      staleMemories.push(memory);
    }
  }

  if (staleMemories.length === 0) {
    return { scanned: memories.length, embedded, skipped };
  }

  // ADR-0017 §1: batch-embed all stale memories in one call
  // instead of N sequential forward passes.
  const texts = staleMemories.map((m) => m.content);
  let vectors: readonly (readonly number[])[] | null = null;
  try {
    vectors = await embedBatchFallback(provider, texts);
  } catch {
    // Batch failed — fall back to per-row embedding below so
    // individual failures are isolated instead of taking down
    // the entire batch.
  }

  if (vectors !== null) {
    // Fast path: batch succeeded. Write each embedding; individual
    // setEmbedding failures are per-row skips, not batch-fatal.
    for (let i = 0; i < staleMemories.length; i += 1) {
      const memory = staleMemories[i];
      const vector = vectors[i];
      if (memory === undefined || vector === undefined) continue;

      try {
        await repo.setEmbedding(
          memory.id,
          { model: provider.model, dimension: provider.dimension, vector },
          { actor: options.actor },
        );
        embedded.push(memory.id);
      } catch (cause) {
        skipped.push({
          id: memory.id,
          reason: 'error',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    }
  } else {
    // Slow path: batch embed threw. Retry each memory individually
    // so a single bad input doesn't take down the entire batch.
    for (const memory of staleMemories) {
      try {
        const vector = await provider.embed(memory.content);
        await repo.setEmbedding(
          memory.id,
          { model: provider.model, dimension: provider.dimension, vector },
          { actor: options.actor },
        );
        embedded.push(memory.id);
      } catch (cause) {
        skipped.push({
          id: memory.id,
          reason: 'error',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    }
  }

  return { scanned: memories.length, embedded, skipped };
}

function isFresh(memory: Memory, provider: EmbeddingProvider): boolean {
  const e = memory.embedding;
  if (e === null) {
    return false;
  }
  return e.model === provider.model && e.dimension === provider.dimension;
}

function clampBatchSize(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_BATCH_SIZE;
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new RangeError('batchSize must be a positive integer');
  }
  return Math.min(raw, MAX_BATCH_SIZE);
}
