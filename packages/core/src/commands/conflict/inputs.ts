// Wire-shape input schemas for the `conflict.*` command set.

import {
  CONFLICT_RESOLUTIONS,
  ConflictIdSchema,
  MEMORY_KIND_TYPES,
  MemoryIdSchema,
  ScopeSchema,
  TimestampSchema,
} from '@psraghuveer/memento-schema';
import { z } from 'zod';

/** `conflict.read`, `conflict.events`. */
export const ConflictIdInputSchema = z
  .object({
    id: ConflictIdSchema,
  })
  .strict();

/**
 * `conflict.list`. Mirrors `ConflictListFilter` from the
 * conflict repository. All filters AND together; ordering is
 * `opened_at desc, id desc`.
 */
export const ConflictListInputSchema = z
  .object({
    open: z.boolean().optional(),
    kind: z.enum(MEMORY_KIND_TYPES).optional(),
    memoryId: MemoryIdSchema.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `conflict.resolve`. The repository writes a `resolved` event
 * with the chosen resolution; structural side-effects (forget /
 * supersede) are the caller's responsibility per the
 * architecture doc.
 */
export const ConflictResolveInputSchema = z
  .object({
    id: ConflictIdSchema,
    resolution: z.enum(CONFLICT_RESOLUTIONS),
  })
  .strict();

/**
 * `conflict.scan`. Two mutually exclusive modes, discriminated
 * by `mode`:
 *
 * - `mode: 'memory'` — runs `detectConflicts` against a single
 *   hydrated memory. Used by the post-write hook recovery path
 *   and by interactive triage.
 * - `mode: 'since'` — re-runs detection over the historical
 *   window of memories created at or after `since`. Used to
 *   recover from missed post-write hooks per
 *   `docs/architecture/conflict-detection.md`.
 *
 * `scopes` and `maxCandidates` are shared between modes. Empty
 * `scopes` is rejected so callers do not accidentally fall
 * through to a no-op SQL filter.
 */
const ScanSharedShape = {
  scopes: z.array(ScopeSchema).min(1).optional(),
  maxCandidates: z.number().int().positive().optional(),
} as const;

export const ConflictScanInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('memory'),
      memoryId: MemoryIdSchema,
      ...ScanSharedShape,
    })
    .strict(),
  z
    .object({
      mode: z.literal('since'),
      since: TimestampSchema,
      ...ScanSharedShape,
    })
    .strict(),
]);
