// Wire-shape input schema for the `compact.*` command set.

import { z } from 'zod';
import { confirmGate } from '../confirm-gate.js';

/**
 * `compact.run`. Mirrors `CompactOptions` minus `actor`, `now`,
 * and `config` — the actor flows from the command context, the
 * clock is the wall clock, and the decay config is taken from
 * `DEFAULT_DECAY_CONFIG`. Per-call config overrides are out of
 * scope for v1; tune via host bootstrap when richer surfaces
 * land.
 *
 * `batchSize` is a positive integer; the upper clamp is a
 * subsystem-level policy concern (resolved from configuration
 * by `compact`) and intentionally not encoded here per
 * AGENTS.md rule 12 — schemas validate shape, not policy.
 *
 * `mode` defaults to `'drain'`: the command loops until an
 * iteration archives no rows (or `compact.run.maxBatches` is
 * hit). `'batch'` preserves the legacy single-batch behaviour
 * for callers that explicitly want one pass.
 */
export const CompactRunInputSchema = z
  .object({
    mode: z
      .enum(['drain', 'batch'])
      .default('drain')
      .describe(
        'Iteration mode. "drain" (default) loops until no rows are archived in a pass or `compact.run.maxBatches` is reached. "batch" performs exactly one pass and returns.',
      ),
    batchSize: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of memories to process per batch. Server uses default if omitted.'),
    confirm: confirmGate().describe(
      'Safety gate — must be true to proceed. Compaction is not reversible.',
    ),
  })
  .strict();
