// Compact — explicit archival pass for memories whose confidence
// has decayed below the configured threshold.
//
// Per `docs/architecture/decay-and-supersession.md`, this is the
// only background-style operation memento ships. It is run by the
// user (or by an external scheduler invoking `memento compact`);
// there is no daemon. The implementation is deliberately
// repository-driven: we do not write SQL here, we drive
// `MemoryRepository.list` + `MemoryRepository.archive`, which
// gives every archival a `MemoryEvent` for free and keeps the
// invariant that all state changes go through the repository.
//
// Selection criteria — both must hold:
//   - `effectiveConfidence(now) < archiveThreshold`
//   - `now − lastConfirmedAt >= archiveAfterMs`
//
// Pinned memories are protected by the `pinnedFloor` clamp inside
// `effectiveConfidence` — `pinnedFloor (default 0.5) ≫ archiveThreshold
// (default 0.05)` — so pinning is in practice an opt-out from
// compaction without needing a separate guard here.

import type { ActorRef, Memory, MemoryId, Timestamp } from '@psraghuveer/memento-schema';
import { CONFIG_KEYS } from '@psraghuveer/memento-schema';
import type { MemoryRepository } from '../repository/memory-repository.js';
import { DEFAULT_DECAY_CONFIG, type DecayConfig, effectiveConfidence } from './engine.js';

/**
 * Result of a single `compact` run. Returned to the caller
 * (typically the `memento compact` CLI) for surface reporting and
 * to the integration tests for assertions.
 */
export interface CompactStats {
  /** Total candidate memories scanned across all surveyed statuses. */
  readonly scanned: number;
  /** Number of memories transitioned to `archived` by this run. */
  readonly archived: number;
  /** Ids of the archived memories, in scan order. */
  readonly archivedIds: readonly MemoryId[];
}

export interface CompactOptions {
  readonly actor: ActorRef;
  readonly now?: Timestamp;
  readonly config?: DecayConfig;
  /**
   * Per-status candidate cap. Defaults to the repository's
   * `MAX_LIMIT` (1_000); compact is intended to be run repeatedly
   * as memories age, not as a one-shot full-table scan. A future
   * cursor-based iterator will replace this when listing learns
   * pagination.
   */
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = CONFIG_KEYS['compact.run.defaultBatchSize'].default;
/**
 * Statuses that compact considers.
 *  - `active`     — the common case.
 *  - `forgotten`  — soft-deleted but recoverable; once cold,
 *                    archive matches the user's intent.
 *
 * `superseded` is intentionally excluded: a superseded row
 * carries a non-null `supersededBy`, which the Memory schema
 * couples to `status === 'superseded'` (see
 * `packages/schema/src/memory.ts`). Archiving such a row would
 * break that invariant. Superseded memories are already
 * excluded from default queries by status filter, so the
 * compactor has no work to do on them.
 *
 * `archived` is excluded — a memory cannot decay any further.
 */
const COMPACTABLE_STATUSES = ['active', 'forgotten'] as const;

/**
 * Run a single compaction pass.
 *
 * The pass is **idempotent**: running it twice in succession with
 * the same clock value archives a memory the first time and is a
 * no-op on the already-archived row the second time (the
 * repository's `archive` is itself idempotent).
 *
 * Errors from individual `archive` calls bubble up — compact is a
 * user-invoked tool and should fail loudly rather than swallow
 * partial state. Already-archived memories are filtered before
 * the call, so the realistic failure mode is a constraint
 * violation we genuinely want to surface.
 */
export async function compact(
  repository: MemoryRepository,
  options: CompactOptions,
): Promise<CompactStats> {
  const config = options.config ?? DEFAULT_DECAY_CONFIG;
  const now = options.now ?? (new Date().toISOString() as unknown as Timestamp);
  const limit = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const candidates: Memory[] = [];
  for (const status of COMPACTABLE_STATUSES) {
    const batch = await repository.list({ status, limit });
    candidates.push(...batch);
  }

  const nowMs = Date.parse(now as unknown as string);
  if (Number.isNaN(nowMs)) {
    throw new Error('compact: options.now is not a valid ISO timestamp');
  }

  const archivedIds: MemoryId[] = [];
  for (const memory of candidates) {
    if (!shouldArchive(memory, now, nowMs, config)) {
      continue;
    }
    await repository.archive(memory.id, { actor: options.actor });
    archivedIds.push(memory.id);
  }

  return {
    scanned: candidates.length,
    archived: archivedIds.length,
    archivedIds,
  };
}

function shouldArchive(
  memory: Memory,
  now: Timestamp,
  nowMs: number,
  config: DecayConfig,
): boolean {
  const confirmedMs = Date.parse(memory.lastConfirmedAt as unknown as string);
  if (Number.isNaN(confirmedMs)) {
    return false;
  }
  if (nowMs - confirmedMs < config.archiveAfterMs) {
    return false;
  }
  return effectiveConfidence(memory, now, config) < config.archiveThreshold;
}
