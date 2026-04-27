// Wire-shape input schema for the `embedding.*` command set.

import { z } from 'zod';

/**
 * `embedding.rebuild`. Mirrors `ReembedOptions` minus `actor`
 * (which is supplied via the command context).
 *
 * `batchSize` is a positive integer; the upper clamp is a
 * subsystem-level policy concern (resolved from configuration
 * by `reembedAll`) and intentionally not encoded here per
 * AGENTS.md rule 12 — schemas validate shape, not policy.
 */
export const EmbeddingRebuildInputSchema = z
  .object({
    batchSize: z.number().int().positive().optional(),
    force: z.boolean().optional(),
    /**
     * Safety gate from ADR-0012. A rebuild rewrites every
     * embedding row and can take minutes on large stores;
     * the gate is invariant (AGENTS.md rule 12).
     */
    confirm: z.literal(true, {
      errorMap: () => ({
        message: 'this operation is destructive; pass { confirm: true } to proceed',
      }),
    }),
  })
  .strict();
