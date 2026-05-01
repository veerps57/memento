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
    id: ConflictIdSchema.describe('The ULID of the conflict to read.'),
  })
  .strict();

/**
 * `conflict.list`. Mirrors `ConflictListFilter` from the
 * conflict repository. All filters AND together; ordering is
 * `opened_at desc, id desc`.
 */
export const ConflictListInputSchema = z
  .object({
    open: z
      .boolean()
      .optional()
      .describe('Filter by open/resolved status. true = open only, false = resolved only. Omit for all.'),
    kind: z
      .enum(MEMORY_KIND_TYPES)
      .optional()
      .describe('Filter by memory kind: "fact", "preference", "decision", "todo", or "snippet".'),
    memoryId: MemoryIdSchema.optional().describe('Filter to conflicts involving a specific memory ULID.'),
    limit: z.number().int().positive().optional().describe('Maximum conflicts to return.'),
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
    id: ConflictIdSchema.describe('The ULID of the conflict to resolve.'),
    resolution: z
      .enum(CONFLICT_RESOLUTIONS)
      .describe('How to resolve: typically "keep_existing", "keep_new", or "merge".'),
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
  scopes: z
    .array(ScopeSchema)
    .min(1)
    .optional()
    .describe('Scopes to scan within. Each element uses the scope discriminated union shape.'),
  maxCandidates: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum candidate memories to compare against. Server uses default if omitted.'),
} as const;

export const ConflictScanInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('memory'),
      memoryId: MemoryIdSchema.describe('The memory ULID to check for conflicts.'),
      ...ScanSharedShape,
    })
    .strict()
    .describe(
      'Scan a single memory for conflicts. Example: {"mode":"memory","memoryId":"01HYXZ..."}',
    ),
  z
    .object({
      mode: z.literal('since'),
      since: TimestampSchema.describe(
        'Scan memories created at or after this ISO-8601 UTC timestamp.',
      ),
      ...ScanSharedShape,
    })
    .strict()
    .describe(
      'Scan all memories created since a timestamp. Example: {"mode":"since","since":"2025-01-01T00:00:00.000Z"}',
    ),
]);
