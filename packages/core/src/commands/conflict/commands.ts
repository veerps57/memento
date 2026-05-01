// `conflict.*` command set — wraps the conflict subsystem
// (`ConflictRepository` plus the `detectConflicts` driver) behind
// the `Command` contract. Same shape as `memory.*`: each handler
// runs a `runRepo` wrapper that catches throws and projects them
// to `Result.err(MementoError)` via `repoErrorToMementoError`.
//
// Surfaces: every command is exposed on both `mcp` and `cli` —
// triage flows want the whole set in either surface.

import { ConflictEventSchema, ConflictSchema, type Result, ok } from '@psraghuveer/memento-schema';
import { z } from 'zod';
import { detectConflicts } from '../../conflict/detector.js';
import type { ConflictRepository } from '../../conflict/repository.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { repoErrorToMementoError } from '../errors.js';
import type { AnyCommand, Command, CommandContext } from '../types.js';
import {
  ConflictIdInputSchema,
  ConflictListInputSchema,
  ConflictResolveInputSchema,
  ConflictScanInputSchema,
} from './inputs.js';

const SURFACES = ['mcp', 'cli'] as const;

const ConflictOutputSchema = ConflictSchema;
const ConflictNullableOutputSchema = ConflictSchema.nullable();
const ConflictListOutputSchema = z.array(ConflictSchema);
const ConflictEventListOutputSchema = z.array(ConflictEventSchema);
const ScanOutputSchema = z
  .object({
    scanned: z.number().int().nonnegative(),
    opened: z.array(ConflictSchema),
  })
  .strict();

function ctxToRepoCtx(ctx: CommandContext): { actor: typeof ctx.actor } {
  return { actor: ctx.actor };
}

async function runRepo<T>(op: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return { ok: false, error: repoErrorToMementoError(error, op) };
  }
}

export interface CreateConflictCommandsDeps {
  readonly conflictRepository: ConflictRepository;
  readonly memoryRepository: MemoryRepository;
}

export function createConflictCommands(deps: CreateConflictCommandsDeps): readonly AnyCommand[] {
  const { conflictRepository: conflicts, memoryRepository: memories } = deps;

  const read: Command<typeof ConflictIdInputSchema, typeof ConflictNullableOutputSchema> = {
    name: 'conflict.read',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: ConflictIdInputSchema,
    outputSchema: ConflictNullableOutputSchema,
    metadata: {
      description: 'Fetch a single conflict by id, or null if absent.',
    },
    handler: async (input) => runRepo('conflict.read', () => conflicts.read(input.id)),
  };

  const list: Command<typeof ConflictListInputSchema, typeof ConflictListOutputSchema> = {
    name: 'conflict.list',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: ConflictListInputSchema,
    outputSchema: ConflictListOutputSchema,
    metadata: {
      description: 'List conflicts. Filters AND together; ordering is opened_at desc, id desc.',
      mcpName: 'list_conflicts',
    },
    handler: async (input) =>
      runRepo('conflict.list', () =>
        conflicts.list({
          ...(input.open !== undefined ? { open: input.open } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.memoryId !== undefined ? { memoryId: input.memoryId } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      ),
  };

  const events: Command<typeof ConflictIdInputSchema, typeof ConflictEventListOutputSchema> = {
    name: 'conflict.events',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: ConflictIdInputSchema,
    outputSchema: ConflictEventListOutputSchema,
    metadata: {
      description: 'All events for one conflict, oldest first.',
      mcpName: 'list_conflict_events',
    },
    handler: async (input) => runRepo('conflict.events', () => conflicts.events(input.id)),
  };

  const resolve: Command<typeof ConflictResolveInputSchema, typeof ConflictOutputSchema> = {
    name: 'conflict.resolve',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: ConflictResolveInputSchema,
    outputSchema: ConflictOutputSchema,
    metadata: {
      description:
        'Resolve an open conflict. Writes a `resolved` event with the chosen resolution.',
    },
    handler: async (input, ctx) =>
      runRepo('conflict.resolve', () =>
        conflicts.resolve(input.id, input.resolution, ctxToRepoCtx(ctx)),
      ),
  };

  const scan: Command<typeof ConflictScanInputSchema, typeof ScanOutputSchema> = {
    name: 'conflict.scan',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: ConflictScanInputSchema,
    outputSchema: ScanOutputSchema,
    metadata: {
      description:
        'Run conflict detection. In `memory` mode, evaluates per-kind policies for one hydrated memory. In `since` mode, replays detection over every active memory created at or after the given timestamp — used to recover from missed post-write hooks.',
      mcpName: 'scan_conflicts',
    },
    handler: async (input, ctx) =>
      runRepo('conflict.scan', async () => {
        const sharedOptions = {
          actor: ctx.actor,
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          ...(input.maxCandidates !== undefined ? { maxCandidates: input.maxCandidates } : {}),
        };
        if (input.mode === 'memory') {
          // `.refine()` guarantees memoryId is present when mode='memory'.
          const memoryId = input.memoryId as NonNullable<typeof input.memoryId>;
          const memory = await memories.read(memoryId);
          if (memory === null) {
            throw new Error(`conflict.scan: memory not found: ${memoryId}`);
          }
          const result = await detectConflicts(
            memory,
            { memoryRepository: memories, conflictRepository: conflicts },
            sharedOptions,
          );
          return { scanned: result.scanned, opened: result.opened.slice() };
        }
        // mode === 'since' — `.refine()` guarantees since is present.
        const since = input.since as NonNullable<typeof input.since>;
        const candidates = await memories.list({
          status: 'active',
          createdAtGte: since,
        });
        let scanned = 0;
        const opened: Awaited<ReturnType<typeof detectConflicts>>['opened'][number][] = [];
        for (const candidate of candidates) {
          const result = await detectConflicts(
            candidate,
            { memoryRepository: memories, conflictRepository: conflicts },
            sharedOptions,
          );
          scanned += result.scanned;
          opened.push(...result.opened);
        }
        return { scanned, opened };
      }),
  };

  return Object.freeze([read, list, events, resolve, scan]) as readonly AnyCommand[];
}
