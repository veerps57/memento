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
  const memories = await repo.list({ status: 'active', limit });

  const embedded: MemoryId[] = [];
  const skipped: ReembedSkip[] = [];

  for (const memory of memories) {
    if (!options.force && isFresh(memory, provider)) {
      skipped.push({ id: memory.id, reason: 'up-to-date' });
      continue;
    }

    let vector: readonly number[];
    try {
      vector = await provider.embed(memory.content);
    } catch (cause) {
      skipped.push({
        id: memory.id,
        reason: 'error',
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
      continue;
    }

    await repo.setEmbedding(
      memory.id,
      { model: provider.model, dimension: provider.dimension, vector },
      { actor: options.actor },
    );
    embedded.push(memory.id);
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
