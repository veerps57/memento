// `compact.*` command set — wraps the `compact` decay-archival
// pass. Side effect is `admin`: the pass only transitions cold
// rows to `archived`, which is reversible via `memory.restore`,
// so it does not warrant `destructive`.

import { MemoryIdSchema, type Result, ok } from '@psraghuveer/memento-schema';
import { z } from 'zod';
import type { ConfigStore } from '../../config/index.js';
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
    /**
     * Number of compact iterations actually run. `1` for `mode: 'batch'`
     * or for a corpus that drains in a single pass; higher values
     * indicate drain mode looped to keep archiving cold rows.
     */
    batches: z.number().int().positive(),
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
  /**
   * Optional config store. When supplied, `compact.run` reads
   * `compact.run.maxBatches` to bound drain-mode iteration. When
   * omitted, drain falls back to a hard-coded safety cap of 100
   * batches — keeps standalone repository-only callers safe.
   */
  readonly configStore?: ConfigStore;
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
        'Run a compaction pass to archive cold memories whose effective confidence has fallen below the decay threshold and have not been confirmed within the archive window. Idempotent.\n\nDefaults to `mode: "drain"` — loops until a pass archives nothing or `compact.run.maxBatches` is reached. Pass `mode: "batch"` to perform exactly one pass (the legacy single-batch behaviour).',
    },
    handler: async (input, ctx) =>
      runRepo('compact.run', async () => {
        const maxBatches = deps.configStore?.get('compact.run.maxBatches') ?? 100;
        let totalScanned = 0;
        let totalArchived = 0;
        const totalArchivedIds: string[] = [];
        let batches = 0;

        // Single iteration in batch mode; loop until no progress in
        // drain mode (default). The loop is bounded by `maxBatches`
        // so a buggy archive call cannot spin forever.
        while (batches < (input.mode === 'drain' ? maxBatches : 1)) {
          const stats = await compact(deps.memoryRepository, {
            actor: ctx.actor,
            ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
          });
          batches += 1;
          totalScanned += stats.scanned;
          totalArchived += stats.archived;
          for (const id of stats.archivedIds) {
            totalArchivedIds.push(id as unknown as string);
          }
          // Drain exit: an iteration that archived nothing means the
          // current candidate window is fully cold-checked. We stop
          // even if older rows beyond the window might still need
          // archiving — that's a pagination-ordering improvement
          // outside the scope of this command.
          if (input.mode !== 'drain' || stats.archived === 0) {
            break;
          }
        }

        return {
          scanned: totalScanned,
          archived: totalArchived,
          archivedIds: totalArchivedIds as never,
          batches,
        };
      }),
  };

  return Object.freeze([run]) as readonly AnyCommand[];
}
