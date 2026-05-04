// Client-side decay computation, mirroring the server-side
// formula (ADR-0004): `effective = stored × 0.5^(Δt/halfLife)`.
//
// We compute decay in the browser so the memory list / detail
// pages can render an "effective confidence" without a round
// trip per row. The half-lives are the registry defaults; if
// the user has overridden them via `decay.halfLifeDays.<kind>`
// we'd ideally resolve those at request time — that's a v0.1
// follow-up.
//
// Pinned memories floor at `decay.pinnedFloor` (default 0.5).

import type { MemoryKindName, MemoryRow } from '../hooks/useMemory.js';

const DAY_MS = 86_400_000;

/** Default half-lives per kind, in days. Mirrors `ConfigKey` defaults. */
export const DEFAULT_HALF_LIFE_DAYS: Record<MemoryKindName, number> = {
  fact: 90,
  preference: 180,
  decision: 365,
  todo: 14,
  snippet: 30,
};

const PINNED_FLOOR_DEFAULT = 0.5;

/**
 * Compute effective confidence for a memory at `now`.
 *
 * Returns a number in `[0, 1]`. Pinned memories never fall
 * below `pinnedFloor`. Memories whose kind is unknown to this
 * mapping fall back to a 90-day half-life (the `fact` default)
 * so a future kind doesn't surface as effective=0.
 */
export function effectiveConfidence(
  memory: Pick<MemoryRow, 'kind' | 'storedConfidence' | 'lastConfirmedAt' | 'pinned'>,
  now: number = Date.now(),
  pinnedFloor: number = PINNED_FLOOR_DEFAULT,
): number {
  const halfLifeDays =
    DEFAULT_HALF_LIFE_DAYS[memory.kind.type as MemoryKindName] ?? DEFAULT_HALF_LIFE_DAYS.fact;
  const lastConfirmedMs = Date.parse(memory.lastConfirmedAt);
  if (!Number.isFinite(lastConfirmedMs)) return memory.storedConfidence;
  const ageDays = Math.max(0, (now - lastConfirmedMs) / DAY_MS);
  const decayFactor = halfLifeDays > 0 ? 2 ** -(ageDays / halfLifeDays) : 1;
  const decayed = memory.storedConfidence * decayFactor;
  if (memory.pinned && decayed < pinnedFloor) return pinnedFloor;
  return clamp01(decayed);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
