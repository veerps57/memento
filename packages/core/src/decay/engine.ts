// Decay — pure, query-time confidence aging.
//
// Per ADR 0004 and `docs/architecture/decay-and-supersession.md`,
// memento does not materialise `effectiveConfidence` in storage.
// Instead we compute it from `(storedConfidence, lastConfirmedAt,
// halfLife, now)` whenever a ranker or the compactor needs it.
// This module is the home of that computation.
//
// Three explicit design choices:
//
//   1. The half-life input is in milliseconds, keeping every
//      timing argument in the same unit as `Date.now()`. We
//      provide pre-computed `MS_PER_DAY` constants in the default
//      config so the architecture-doc table (90 days, 180 days,
//      …) is a one-liner.
//   2. `decayFactor` clamps non-positive deltas to 1: a future
//      `lastConfirmedAt` (from clock skew, mocked test clocks,
//      or a manual data fix) should never produce a >1 factor
//      that pushes effectiveConfidence above its stored value.
//   3. `effectiveConfidence` applies the pinned floor *after* the
//      decay multiply so a pinned memory always reads at or
//      above `pinnedFloor` regardless of how stale it is. This
//      matches the architecture doc verbatim.

import type { Memory, MemoryKindType, Timestamp } from '@psraghuveer/memento-schema';
import { type ConfigStore, createConfigStore } from '../config/index.js';

/** Milliseconds in one day, exposed so callers can build their own decay configs without re-deriving the constant. */
export const MS_PER_DAY = 86_400_000;

/**
 * Half-life by `MemoryKind.type`, in **milliseconds**. Every kind
 * must have a value — the configured map is exhaustive over
 * `MemoryKindType` so a future kind addition forces a deliberate
 * choice rather than a silent default.
 */
export type HalfLifeByKind = Readonly<Record<MemoryKindType, number>>;

/**
 * Configuration consumed by the decay engine and by `compact`.
 * Every field maps to a `decay.*` config key documented in
 * `docs/architecture/decay-and-supersession.md`:
 *
 * - `halfLifeByKind`  → `decay.halfLife.<kind>`
 * - `pinnedFloor`     → `decay.pinnedFloor`
 * - `archiveThreshold`→ `decay.archiveThreshold`
 * - `archiveAfterMs`  → `decay.archiveAfter`
 *
 * `archiveAfterMs` is a duration in ms (matching the half-life
 * unit), not a `Timestamp`. The architecture doc states the
 * default in days; we convert at the constant level.
 */
export interface DecayConfig {
  readonly halfLifeByKind: HalfLifeByKind;
  readonly pinnedFloor: number;
  readonly archiveThreshold: number;
  readonly archiveAfterMs: number;
}

/**
 * Build a `DecayConfig` from a `ConfigStore`. This is how
 * subsystems source decay parameters at runtime: the registry
 * (`@psraghuveer/memento-schema/config-keys`) owns the defaults and the
 * permitted shape, and the store layers user/workspace/env/cli/mcp
 * overrides on top per `docs/architecture/config.md`.
 *
 * Pure over `(store)` — re-running with the same store yields the
 * same config, which preserves the determinism guarantee the
 * audit-log story relies on.
 */
export function decayConfigFromStore(store: ConfigStore): DecayConfig {
  return {
    halfLifeByKind: {
      fact: store.get('decay.halfLife.fact'),
      preference: store.get('decay.halfLife.preference'),
      decision: store.get('decay.halfLife.decision'),
      todo: store.get('decay.halfLife.todo'),
      snippet: store.get('decay.halfLife.snippet'),
    },
    pinnedFloor: store.get('decay.pinnedFloor'),
    archiveThreshold: store.get('decay.archiveThreshold'),
    archiveAfterMs: store.get('decay.archiveAfter'),
  };
}

/**
 * Defaults match the table in `docs/architecture/decay-and-supersession.md`.
 * Derived from the `CONFIG_KEYS` registry so the registry is the
 * single source of truth — changing a default here means changing
 * the registered `default` on the corresponding key.
 */
export const DEFAULT_DECAY_CONFIG: DecayConfig = decayConfigFromStore(createConfigStore());

/**
 * `decayFactor(Δt, halfLife) = 0.5 ^ (Δt / halfLife)`.
 *
 * - Δt and halfLife are both in milliseconds.
 * - Negative or zero Δt clamps to a factor of `1` (no decay).
 *   This is the tolerant branch for clocks that briefly run
 *   backwards.
 * - `halfLife` must be a positive finite number; a zero or
 *   negative half-life is a configuration error and throws.
 */
export function decayFactor(deltaMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) {
    throw new RangeError(`decayFactor: halfLifeMs must be > 0 (got ${halfLifeMs})`);
  }
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return 1;
  }
  return 0.5 ** (deltaMs / halfLifeMs);
}

/**
 * Effective confidence at `now` for a memory:
 *
 *   raw       = storedConfidence × decayFactor(now − lastConfirmedAt, halfLife[kind])
 *   effective = pinned ? max(raw, pinnedFloor) : raw
 *
 * `now` is an ISO-8601 `Timestamp` to match the rest of the
 * repository surface; it is parsed into epoch-ms internally.
 */
export function effectiveConfidence(
  memory: Memory,
  now: Timestamp,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const halfLife = config.halfLifeByKind[memory.kind.type];
  if (halfLife === undefined) {
    throw new Error(`effectiveConfidence: missing halfLife for kind ${memory.kind.type}`);
  }
  const nowMs = Date.parse(now as unknown as string);
  const confirmedMs = Date.parse(memory.lastConfirmedAt as unknown as string);
  if (Number.isNaN(nowMs) || Number.isNaN(confirmedMs)) {
    throw new Error('effectiveConfidence: lastConfirmedAt or now is not a valid ISO timestamp');
  }
  const raw = memory.storedConfidence * decayFactor(nowMs - confirmedMs, halfLife);
  return memory.pinned ? Math.max(raw, config.pinnedFloor) : raw;
}
