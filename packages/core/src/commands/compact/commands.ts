// `compact.*` command set — wraps the `compact` decay-archival
// pass. Side effect is `admin`: the pass only transitions cold
// rows to `archived`, which is reversible via `memory.restore`,
// so it does not warrant `destructive`.

import { MemoryIdSchema, type Result, ok } from '@psraghuveer/memento-schema';
import { z } from 'zod';
import { compact } from '../../decay/compact.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { repoErrorToMementoError } from '../errors.js';
import type { AnyCommand, Command } from '../types.js';
import { CompactRunInputSchema } from './inputs.js';

const SURFACES = ['mcp', 'cli'] as const;

const CompactRunOutputSchema = z
  .object({
    scanned: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    archivedIds: z.array(MemoryIdSchema),
  })
  .strict();

async function runRepo<T>(op: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return { ok: false, error: repoErrorToMementoError(error, op) };
  }
}

export interface CreateCompactCommandsDeps {
  readonly memoryRepository: MemoryRepository;
}

export function createCompactCommands(deps: CreateCompactCommandsDeps): readonly AnyCommand[] {
  const run: Command<typeof CompactRunInputSchema, typeof CompactRunOutputSchema> = {
    name: 'compact.run',
    sideEffect: 'admin',
    surfaces: SURFACES,
    inputSchema: CompactRunInputSchema,
    outputSchema: CompactRunOutputSchema,
    metadata: {
      description:
        'Run a single compaction pass. Archives active/forgotten memories whose effective confidence has fallen below the decay threshold and have not been confirmed within the archive window. Idempotent.',
    },
    handler: async (input, ctx) =>
      runRepo('compact.run', async () => {
        const stats = await compact(deps.memoryRepository, {
          actor: ctx.actor,
          ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
        });
        return {
          scanned: stats.scanned,
          archived: stats.archived,
          archivedIds: stats.archivedIds.slice(),
        };
      }),
  };

  return Object.freeze([run]) as readonly AnyCommand[];
}
