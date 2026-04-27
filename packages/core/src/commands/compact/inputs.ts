// Wire-shape input schema for the `compact.*` command set.

import { z } from 'zod';

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
 */
export const CompactRunInputSchema = z
  .object({
    batchSize: z.number().int().positive().optional(),
    /**
     * Safety gate from ADR-0012. Compaction rewrites memory
     * status and is not reversible by an inverse command;
     * the gate is invariant (AGENTS.md rule 12).
     */
    confirm: z.literal(true, {
      errorMap: () => ({
        message: 'this operation is destructive; pass { confirm: true } to proceed',
      }),
    }),
  })
  .strict();
