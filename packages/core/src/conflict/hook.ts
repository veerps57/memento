// Post-write conflict-detection hook.
//
// ADR-0005 mandates that conflict detection runs *after* a
// memory write commits, never inline. This module implements
// the bounded, fire-and-forget executor the write path uses to
// honour that contract:
//
//   memory.write → commit → return to caller
//                       │
//                       └─▶ runConflictHook(memory, …)  (not awaited)
//                                │
//                                ▼
//                         detectConflicts(...)
//                          racing setTimeout(timeoutMs)
//
// `runConflictHook` is a pure async function over its inputs.
// It never throws — all failure modes (disabled, timeout,
// detector error) are projected onto a discriminated
// {@link ConflictHookOutcome} so the caller can decide whether
// to log, increment a counter, or ignore. Errors are not
// rethrown because the write has already succeeded; surfacing a
// detector failure as a thrown rejection would only orphan a
// promise. Re-detection is the recovery path
// (`memento conflicts scan`).
//
// The detector itself, the per-kind policies, and the
// repository writes are unchanged — this module is the thin
// scheduling layer that owns the `conflict.enabled` /
// `conflict.timeoutMs` / `conflict.scopeStrategy` contract.

import type { ActorRef, Conflict, Memory, Scope } from '@psraghuveer/memento-schema';
import type { MemoryRepository } from '../repository/memory-repository.js';
import { type ActiveScopes, effectiveScopes } from '../scope/resolver.js';
import { type DetectConflictsOptions, detectConflicts } from './detector.js';
import type { ConflictPolicyConfig } from './policies.js';
import type { ConflictRepository } from './repository.js';

/**
 * The slice of `CONFIG_KEYS` the hook consumes. Pulled out as a
 * plain object so the caller (a future `runtimeConfig`-aware
 * adapter, or a test) can build it from any source — the live
 * `ConfigStore`, a fixture, or hard-coded defaults.
 */
export interface ConflictHookConfig {
  /** `conflict.enabled` — when false, the hook short-circuits to `disabled`. */
  readonly enabled: boolean;
  /** `conflict.timeoutMs` — wall-clock budget for the entire hook run. */
  readonly timeoutMs: number;
  /**
   * `conflict.scopeStrategy` — `'same'` checks only the new
   * memory's own scope; `'effective'` widens to the layered
   * effective scope set (requires `activeScopes`).
   */
  readonly scopeStrategy: 'same' | 'effective';
}

/**
 * Repository deps the hook hands to {@link detectConflicts}.
 */
export interface ConflictHookDeps {
  readonly memoryRepository: MemoryRepository;
  readonly conflictRepository: ConflictRepository;
}

/**
 * Per-call inputs.
 *
 * `actor` is the actor recorded on every emitted `opened`
 * event — typically the same `actor` that authored the write.
 *
 * `activeScopes` is consulted only when
 * `scopeStrategy === 'effective'`; it is the layered scope
 * snapshot used by the read-side ranker. When the strategy is
 * `'same'` the field is ignored, so callers in `'same'` mode
 * may omit it.
 *
 * The two timer hooks (`setTimeout`, `clearTimeout`) are
 * injectable purely for deterministic tests — production paths
 * use the globals.
 */
export interface ConflictHookOptions {
  readonly actor: ActorRef;
  readonly activeScopes?: ActiveScopes;
  readonly policyConfig?: ConflictPolicyConfig;
  readonly maxCandidates?: number;
  readonly setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutImpl?: (handle: never) => void;
  readonly now?: () => number;
}

/**
 * Discriminated outcome of a single hook invocation.
 *
 *   - `disabled`  — `config.enabled` was false; nothing ran.
 *   - `completed` — detector finished within the budget.
 *   - `timeout`   — detector did not finish within the budget;
 *                   the in-flight work is abandoned.
 *   - `error`     — the detector or repository threw; the
 *                   underlying value is preserved verbatim so
 *                   the caller can structure a log line.
 */
export type ConflictHookOutcome =
  | { readonly status: 'disabled' }
  | {
      readonly status: 'completed';
      readonly scanned: number;
      readonly opened: readonly Conflict[];
      readonly elapsedMs: number;
    }
  | { readonly status: 'timeout'; readonly elapsedMs: number }
  | {
      readonly status: 'error';
      readonly error: unknown;
      readonly elapsedMs: number;
    };

const TIMEOUT_SENTINEL = Symbol('conflict-hook-timeout');

function pickScopes(
  memory: Memory,
  config: ConflictHookConfig,
  activeScopes: ActiveScopes | undefined,
): readonly Scope[] {
  if (config.scopeStrategy === 'same' || activeScopes === undefined) {
    return [memory.scope];
  }
  return effectiveScopes(activeScopes);
}

/**
 * Run the post-write conflict-detection hook for a single
 * freshly-committed memory.
 *
 * The function is non-throwing: every failure mode is folded
 * into the returned {@link ConflictHookOutcome}. Callers
 * (`memory.write`, `memory.supersede`, `memory.update`) start
 * the promise without awaiting it; the write's caller has
 * already received their `Result.ok` by the time this resolves.
 */
export async function runConflictHook(
  memory: Memory,
  deps: ConflictHookDeps,
  config: ConflictHookConfig,
  options: ConflictHookOptions,
): Promise<ConflictHookOutcome> {
  if (!config.enabled) {
    return { status: 'disabled' };
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);

  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;

  const detectOptions: DetectConflictsOptions = {
    actor: options.actor,
    scopes: pickScopes(memory, config, options.activeScopes),
    ...(options.policyConfig !== undefined ? { policyConfig: options.policyConfig } : {}),
    ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
  };

  let timeoutHandle: unknown;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeoutImpl(() => resolve(TIMEOUT_SENTINEL), config.timeoutMs);
  });

  try {
    const winner = await Promise.race([
      detectConflicts(memory, deps, detectOptions),
      timeoutPromise,
    ]);
    if (winner === TIMEOUT_SENTINEL) {
      return { status: 'timeout', elapsedMs: elapsed() };
    }
    return {
      status: 'completed',
      scanned: winner.scanned,
      opened: winner.opened,
      elapsedMs: elapsed(),
    };
  } catch (error) {
    return { status: 'error', error, elapsedMs: elapsed() };
  } finally {
    if (timeoutHandle !== undefined) {
      // Type is intentionally `unknown` here: the SDK signature
      // for `clearTimeout` accepts `string | number | Timeout`,
      // but the injectable `setTimeoutImpl` may legitimately
      // return any handle shape (e.g. a node `Timeout`, a number
      // in a browser polyfill, or `0` from a test stub). Coerce
      // through `as never` so the user-supplied
      // `clearTimeoutImpl` matches whatever the user-supplied
      // `setTimeoutImpl` produced.
      clearTimeoutImpl(timeoutHandle as never);
    }
  }
}
