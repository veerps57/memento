// `embedding.*` command set — wraps the standalone `reembedAll`
// driver behind the `Command` contract. Returns a serialisable
// summary: `error: Error` instances on per-row skips are
// projected to `errorMessage: string` so the result is wire-safe.

import { MemoryIdSchema, type Result, ok } from '@psraghuveer/memento-schema';
import { z } from 'zod';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import { reembedAll } from '../../embedding/reembed.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { repoErrorToMementoError } from '../errors.js';
import type { AnyCommand, Command } from '../types.js';
import { EmbeddingRebuildInputSchema } from './inputs.js';

const SURFACES = ['mcp', 'cli'] as const;

const ReembedSkipOutputSchema = z
  .object({
    id: MemoryIdSchema,
    reason: z.enum(['up-to-date', 'error']),
    errorMessage: z.string().optional(),
  })
  .strict();

const ReembedOutputSchema = z
  .object({
    scanned: z.number().int().nonnegative(),
    embedded: z.array(MemoryIdSchema),
    skipped: z.array(ReembedSkipOutputSchema),
  })
  .strict();

async function runRepo<T>(op: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return { ok: false, error: repoErrorToMementoError(error, op) };
  }
}

export interface CreateEmbeddingCommandsDeps {
  readonly memoryRepository: MemoryRepository;
  readonly provider: EmbeddingProvider;
}

export function createEmbeddingCommands(deps: CreateEmbeddingCommandsDeps): readonly AnyCommand[] {
  const rebuild: Command<typeof EmbeddingRebuildInputSchema, typeof ReembedOutputSchema> = {
    name: 'embedding.rebuild',
    sideEffect: 'admin',
    surfaces: SURFACES,
    inputSchema: EmbeddingRebuildInputSchema,
    outputSchema: ReembedOutputSchema,
    metadata: {
      description:
        'Rebuild embeddings for active memories whose stored embedding does not match the configured provider. Page by re-invoking with the same options; per-row provider errors are recorded as skips and do not halt the batch.',
      mcpName: 'rebuild_embeddings',
    },
    handler: async (input, ctx) =>
      runRepo('embedding.rebuild', async () => {
        const result = await reembedAll(deps.memoryRepository, deps.provider, {
          actor: ctx.actor,
          ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
          ...(input.includeNonActive !== undefined
            ? { includeNonActive: input.includeNonActive }
            : {}),
        });
        return {
          scanned: result.scanned,
          embedded: result.embedded.slice(),
          skipped: result.skipped.map((skip) => ({
            id: skip.id,
            reason: skip.reason,
            ...(skip.error !== undefined ? { errorMessage: skip.error.message } : {}),
          })),
        };
      }),
  };

  return Object.freeze([rebuild]) as readonly AnyCommand[];
}
