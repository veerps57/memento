// Wire-shape input schema for the `embedding.*` command set.

import { z } from 'zod';
import { confirmGate } from '../confirm-gate.js';

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
    batchSize: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Number of memories to embed per batch. Server uses default if omitted.'),
    force: z
      .boolean()
      .optional()
      .describe('If true, re-embeds all memories even if they already have an embedding for the current model.'),
    confirm: confirmGate().describe(
      'Safety gate — must be true to proceed. Rebuild rewrites all embeddings and may take minutes.',
    ),
  })
  .strict();
