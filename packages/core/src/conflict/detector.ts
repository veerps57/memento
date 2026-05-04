// Conflict detector — given a freshly-written memory, fetches
// candidates and runs the per-kind policy against each.
//
// Per ADR-0005, this runs *after* the write commits, so the
// detector takes a `Memory` (not `MemoryWriteInput`) — the row
// is already durable and has its assigned id, status, and
// timestamps. The function is callable on its own and is the
// integration point the eventual server will wire into a
// post-write hook bounded by `conflict.timeoutMs`.
//
// Determinism: the detector is pure over `(memory, candidates,
// config)` once `repository.list` returns. That gives `memento
// conflicts scan` the deterministic re-run guarantee the
// architecture doc requires — feed the same audit log through
// the same policies, get the same conflicts.
//
// Scope strategy: defaults to `'same'` per the architecture doc.
// Callers may pass an explicit `scopes` array to widen (e.g. to
// the layered effective set produced by `resolveEffectiveScopes`).

import type { ActorRef, Conflict, Memory, Scope } from '@psraghuveer/memento-schema';
import { CONFIG_KEYS } from '@psraghuveer/memento-schema';
import type { MemoryRepository } from '../repository/memory-repository.js';
import { type ConflictPolicyConfig, DEFAULT_POLICY_CONFIG, runPolicy } from './policies.js';
import type { ConflictRepository } from './repository.js';

/**
 * Cap on candidates fetched per detection run. Sourced from the
 * `conflict.detector.maxCandidates` config key so operators can
 * tune the post-write hook ceiling without a code change. Picked
 * to match `MemoryRepository.MAX_LIMIT` — at the upper bound,
 * detection still completes in a single list call without
 * pagination, and the cost is bounded for the post-write hook.
 */
const MAX_CANDIDATES = CONFIG_KEYS['conflict.detector.maxCandidates'].default;

export interface DetectConflictsOptions {
  readonly actor: ActorRef;
  /**
   * Scopes to scan for candidates. Defaults to `[memory.scope]`
   * (the architecture-doc default of `conflict.scopeStrategy =
   * 'same'`). Pass a wider list to opt into `'effective'`.
   */
  readonly scopes?: readonly Scope[];
  readonly policyConfig?: ConflictPolicyConfig;
  /** Override the per-status-per-kind candidate cap. */
  readonly maxCandidates?: number;
}

export interface DetectConflictsResult {
  /** Number of candidates considered (after pre-filtering). */
  readonly scanned: number;
  /** Conflicts opened by this run. */
  readonly opened: readonly Conflict[];
}

/**
 * Run conflict detection for `memory`. For each active candidate
 * of the same kind in the configured scope set, evaluate the
 * registered per-kind policy; on each `{conflict: true}` result,
 * open a conflict record + emit an `opened` event via
 * {@link ConflictRepository.open}.
 *
 * Errors from `conflictRepository.open` bubble up — the caller
 * (post-write hook) decides whether to swallow them. Failing
 * loud here matches the pattern in the rest of the engine.
 */
export async function detectConflicts(
  memory: Memory,
  deps: {
    memoryRepository: MemoryRepository;
    conflictRepository: ConflictRepository;
  },
  options: DetectConflictsOptions,
): Promise<DetectConflictsResult> {
  const scopes = options.scopes ?? [memory.scope];
  const policyConfig = {
    ...DEFAULT_POLICY_CONFIG,
    ...(options.policyConfig ?? {}),
  };
  const limit = options.maxCandidates ?? MAX_CANDIDATES;

  const candidates = await deps.memoryRepository.list({
    status: 'active',
    kind: memory.kind.type,
    scope: scopes,
    limit,
  });

  // Pull the set of memories already paired with `memory` in an
  // open conflict (either direction) so we can skip
  // already-known pairs. Without this dedup, every re-run of
  // `conflict.scan since` and every redundant post-write hook
  // fire would insert a fresh `(memoryId, candidateId)` row for
  // the same logical pair — observable in the dashboard's
  // overview tile as a count that grows monotonically with the
  // number of times the user pressed "re-scan (24h)".
  // Cloned to a mutable Set so we can amend it as we open new
  // conflicts within this run (avoids double-opens when two
  // candidates land on the same partner via different paths).
  const alreadyPaired = new Set(await deps.conflictRepository.openPartners(memory.id));

  const opened: Conflict[] = [];
  for (const candidate of candidates) {
    if (alreadyPaired.has(candidate.id)) continue;
    const result = runPolicy(memory, candidate, policyConfig);
    if (!result.conflict) {
      continue;
    }
    const conflict = await deps.conflictRepository.open(
      {
        newMemoryId: memory.id,
        conflictingMemoryId: candidate.id,
        kind: memory.kind.type,
        evidence: result.evidence,
      },
      { actor: options.actor },
    );
    opened.push(conflict);
    // Track the new pair so a single scan over the same memory
    // (or via candidates that recurse back to it) doesn't
    // double-open within the run.
    alreadyPaired.add(candidate.id);
  }

  return { scanned: candidates.length, opened };
}
