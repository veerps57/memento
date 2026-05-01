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
      .describe(
        'Filter by open/resolved status. true = open only, false = resolved only. Omit for all.',
      ),
    kind: z
      .enum(MEMORY_KIND_TYPES)
      .optional()
      .describe('Filter by memory kind: "fact", "preference", "decision", "todo", or "snippet".'),
    memoryId: MemoryIdSchema.optional().describe(
      'Filter to conflicts involving a specific memory ULID.',
    ),
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
 * `conflict.scan`. Two mutually exclusive modes controlled by
 * `mode`:
 *
 * - `mode: 'memory'` — runs `detectConflicts` against a single
 *   hydrated memory. Requires `memoryId`. Used by the post-write
 *   hook recovery path and by interactive triage.
 * - `mode: 'since'` — re-runs detection over the historical
 *   window of memories created at or after `since`. Requires
 *   `since`. Used to recover from missed post-write hooks per
 *   `docs/architecture/conflict-detection.md`.
 *
 * `scopes` and `maxCandidates` are shared between modes. Empty
 * `scopes` is rejected so callers do not accidentally fall
 * through to a no-op SQL filter.
 *
 * NOTE: this schema is deliberately a flat object (not a
 * discriminatedUnion) because MCP clients (Claude Desktop,
 * others) strip JSON Schema `oneOf` branches, rendering
 * union-shaped tools unusable. The conditional requirement
 * (`memoryId` when mode=memory, `since` when mode=since) is
 * enforced via `.refine()`.
 */
export const ConflictScanInputSchema = z
  .object({
    mode: z
      .enum(['memory', 'since'])
      .describe(
        'Scan mode. "memory" checks one memory for conflicts (requires memoryId). "since" replays detection over all memories created since a timestamp (requires since).',
      ),
    memoryId: MemoryIdSchema.optional().describe(
      'Required when mode="memory". The memory ULID to check for conflicts.',
    ),
    since: TimestampSchema.optional().describe(
      'Required when mode="since". Scan memories created at or after this ISO-8601 UTC timestamp.',
    ),
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
  })
  .strict()
  .refine((input) => input.mode !== 'memory' || input.memoryId !== undefined, {
    message: 'memoryId is required when mode is "memory"',
    path: ['memoryId'],
  })
  .refine((input) => input.mode !== 'since' || input.since !== undefined, {
    message: 'since is required when mode is "since"',
    path: ['since'],
  });
