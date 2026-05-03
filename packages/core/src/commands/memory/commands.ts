// `memory.*` command set — wraps a `MemoryRepository` instance
// behind the typed `Command` contract. Each command:
//
// - Declares its on-the-wire input schema (via `./inputs.ts`).
// - Declares its output schema using the canonical entity
//   shapes from `@psraghuveer/memento-schema`.
// - Catches repository throws and projects them into
//   `Result.err(MementoError)` via `repoErrorToMementoError`.
// - Sets `surfaces: ['mcp', 'cli']` — the same set for every
//   data-plane memory op in v1. (The server and CLI adapters
//   both expose these; the contract test will pin parity.)
//
// The factory takes a `MemoryRepository` and returns an
// immutable list of `AnyCommand`s. The caller (typically a
// host bootstrap) hands them to `createRegistry().register(…)`.

import type {
  ActorRef,
  MementoError,
  Memory,
  MemoryEvent,
  MemoryId,
  MemoryView,
  Result,
  Tag,
} from '@psraghuveer/memento-schema';
import {
  MemoryEventSchema,
  MemoryIdSchema,
  MemorySchema,
  MemoryViewSchema,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import { z } from 'zod';
import type { ConfigStore } from '../../config/index.js';
import type { EventRepository } from '../../repository/event-repository.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { repoErrorToMementoError } from '../errors.js';
import type { AnyCommand, Command, CommandContext } from '../types.js';

import {
  MemoryArchiveInputSchema,
  MemoryArchiveManyInputSchema,
  MemoryConfirmManyInputSchema,
  MemoryEventsInputSchema,
  MemoryForgetInputSchema,
  MemoryForgetManyInputSchema,
  MemoryIdInputSchema,
  MemoryListInputSchema,
  MemoryReadInputSchema,
  MemorySetEmbeddingInputSchema,
  MemorySupersedeInputSchema,
  MemoryUpdateInputSchema,
  MemoryWriteInputSchema,
  MemoryWriteManyInputSchema,
} from './inputs.js';
import { enforceSafetyCaps, rationaleFromKind } from './safety-caps.js';

const SURFACES = ['mcp', 'cli'] as const;

const MemoryOutputSchema = MemorySchema;
const MemoryNullableOutputSchema = MemorySchema.nullable();
const MemoryListOutputSchema = z.array(MemoryViewSchema);
const MemoryEventListOutputSchema = z.array(MemoryEventSchema);
const MemoryWriteManyOutputSchema = z
  .object({
    ids: z.array(MemoryIdSchema),
    idempotentCount: z.number().int().nonnegative(),
  })
  .strict();

const ConfirmManyOutputSchema = z
  .object({
    confirmed: z.number().int().nonnegative(),
    failed: z.array(
      z
        .object({
          id: z.string(),
          code: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
const SupersedeOutputSchema = z
  .object({
    previous: MemorySchema,
    current: MemorySchema,
  })
  .strict();

// ADR-0014. Bulk-destructive verbs return the same shape: how
// many rows the filter matched, how many were transitioned (0
// in dry-run; matched − idempotent in apply mode), and the
// full id list ordered by `repo.list`.
const MemoryBulkResultSchema = z
  .object({
    dryRun: z.boolean(),
    matched: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    idempotent: z.number().int().nonnegative(),
    ids: z.array(MemoryIdSchema),
  })
  .strict();

/**
 * Wrap a repository call in `try/catch` and project both branches
 * onto `Result`. Hoisted so every handler in the file gets the
 * same error-mapping policy without copy/paste.
 */
async function runRepo<T>(op: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (caught) {
    return err<MementoError>(repoErrorToMementoError(caught, op));
  }
}

/**
 * Optional hooks the integrator may pass to
 * {@link createMemoryCommands}. Currently a single slot —
 * `afterWrite` — that fires after `memory.write` and
 * `memory.supersede` produce a freshly-active memory.
 *
 * The contract is fire-and-forget:
 *
 *   - The hook is invoked **after** the `Result.ok` is
 *     constructed and **before** the handler returns. This
 *     means a synchronous handle is registered before the
 *     caller's `await` resolves; an asynchronous body inside
 *     the hook continues running in the background.
 *   - The hook's return value is ignored. If it returns a
 *     Promise (which `runConflictHook` does), that promise is
 *     intentionally not awaited — the write's caller already
 *     has their `Result`.
 *   - Synchronous throws are caught and swallowed so a buggy
 *     hook cannot corrupt the write's `Result`. Asynchronous
 *     rejections are the integrator's responsibility (the
 *     canonical `runConflictHook` is non-throwing).
 *
 * The hook is intentionally typed as a plain `Memory` +
 * `CommandContext` consumer rather than something
 * `conflict`-specific so the commands package stays decoupled
 * from the conflict subsystem. Only the bootstrap that owns
 * `runConflictHook`'s deps + config knows how to wire them in.
 *
 * `ctx` is forwarded so the hook can attribute any audit
 * events it emits (e.g. the conflict subsystem's `opened`
 * events) to the same actor that authored the write — without
 * it the hook would have to invent a synthetic actor and the
 * audit log would lose the chain.
 *
 * Per ADR-0005 / `docs/architecture/conflict-detection.md`,
 * v1 fires the hook on `memory.write` and `memory.supersede`
 * only — not `memory.update` (taxonomy-only) or `memory.confirm`
 * (no content change). Restore / archive / forget are out of
 * scope: they do not produce a freshly-authored active memory
 * whose content needs scanning.
 */
export interface MemoryCommandHooks {
  readonly afterWrite?: (memory: Memory, ctx: CommandContext) => void;
}

function fireAfterWrite(
  hooks: MemoryCommandHooks | undefined,
  memory: Memory,
  ctx: CommandContext,
): void {
  const hook = hooks?.afterWrite;
  if (hook === undefined) {
    return;
  }
  try {
    hook(memory, ctx);
  } catch {
    // Fire-and-forget: a buggy synchronous hook must not
    // corrupt the write's Result. The integrator is
    // responsible for surfacing async rejections.
  }
}

/**
 * Optional repository dependencies for {@link createMemoryCommands}.
 *
 * `eventRepository` is required to register `memory.events`; when
 * absent the command is omitted (rather than registered-and-broken).
 * Bootstrap supplies it from the same `Kysely` handle as the
 * memory repository so the audit-log read path is
 * transactionally consistent with writes.
 */
export interface MemoryCommandDeps {
  readonly eventRepository?: EventRepository;
  /**
   * Optional config store. When supplied, `memory.list` honours
   * the `privacy.redactSensitiveSnippets` flag (ADR-0012 §3) and
   * projects sensitive rows through the redacted view. When
   * omitted, list returns full content for every row — hosts
   * that don't run the config subsystem stay backwards-
   * compatible.
   */
  readonly configStore?: ConfigStore;
}

/**
 * Build the v1 `memory.*` command set bound to a repository
 * instance. The returned array is frozen so accidental
 * post-construction mutation does not desync the MCP and CLI
 * projections.
 *
 * `hooks.afterWrite`, when supplied, fires after every
 * successful `memory.write` and `memory.supersede` (using
 * `current`). See {@link MemoryCommandHooks}.
 *
 * `deps.eventRepository`, when supplied, enables the
 * `memory.events` command. See {@link MemoryCommandDeps}.
 */
export function createMemoryCommands(
  repo: MemoryRepository,
  hooks?: MemoryCommandHooks,
  deps?: MemoryCommandDeps,
): readonly AnyCommand[] {
  const writeCommand: Command<typeof MemoryWriteInputSchema, typeof MemoryOutputSchema> = {
    name: 'memory.write',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: MemoryWriteInputSchema,
    outputSchema: MemoryOutputSchema,
    metadata: {
      description:
        'Create a new memory in the given scope.\n\nWorkflow: search first to avoid duplicates. If a similar memory exists, use memory.supersede to update it instead. Use memory.update for non-content changes (tags, kind, pinned, sensitive).\n\nFor `preference` and `decision` kinds, start the content with a single `topic: value` line followed by free prose. Conflict detection parses that first line — without it two contradictory preferences silently coexist. Example: `node-package-manager: pnpm\\n\\nRaghu prefers pnpm over npm for Node projects.`\n\nMinimal example (pinned, storedConfidence, summary, owner all have defaults):\n\n```json\n{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["project:memento"],"content":"Memento uses SQLite for storage."}\n```\n\nFull example:\n\n```json\n{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["project:memento"],"pinned":false,"content":"Memento uses SQLite for storage.","summary":"Storage engine choice","storedConfidence":0.95}\n```',
    },
    handler: async (input, ctx) => {
      if (deps?.configStore !== undefined) {
        const cap = enforceSafetyCaps(
          'memory.write',
          {
            content: input.content,
            summary: input.summary,
            tags: input.tags,
            rationale: rationaleFromKind(input.kind),
          },
          deps.configStore,
        );
        if (!cap.ok) return cap;
      }
      const pinned = input.pinned ?? deps?.configStore?.get('write.defaultPinned') ?? false;
      const storedConfidence =
        input.storedConfidence ?? deps?.configStore?.get('write.defaultConfidence') ?? 1;
      const result = await runRepo<Memory>('memory.write', () =>
        repo.write(
          {
            scope: input.scope,
            owner: input.owner,
            kind: input.kind,
            tags: [...input.tags],
            pinned,
            content: input.content,
            summary: input.summary,
            storedConfidence,
            ...(input.clientToken !== undefined ? { clientToken: input.clientToken } : {}),
            ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
          },
          ctxToRepoCtx(ctx),
        ),
      );
      if (result.ok) {
        fireAfterWrite(hooks, result.value, ctx);
        return ok(projectMemoryForOutput(result.value, deps?.configStore, false));
      }
      return result;
    },
  };

  const writeManyCommand: Command<
    typeof MemoryWriteManyInputSchema,
    typeof MemoryWriteManyOutputSchema
  > = {
    name: 'memory.write_many',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: MemoryWriteManyInputSchema,
    outputSchema: MemoryWriteManyOutputSchema,
    metadata: {
      description:
        'Atomically create multiple memories in a single transaction. Per-item clientToken idempotency is honoured; on any failure the whole batch rolls back.\n\nProgrammatic / operator surface — AI assistants typically do NOT reach for this. For multiple explicit user statements ("remember A, B, and C"), prefer N sequential `write_memory` calls so one bad item does not roll the others back. For end-of-session sweeps over things the user mentioned in passing, use `extract_memory` (server dedups + scrubs + lowers confidence). Use `write_many_memories` only when you genuinely need all-or-nothing transactional semantics — e.g. importing a curated batch from a doc.',
      mcpName: 'write_many_memories',
    },
    handler: async (input, ctx) => {
      // ADR-0012 §4: enforce the configured batch ceiling
      // *before* shaping inputs into repository values. Without
      // a config store the cap is unenforceable on this host —
      // we still apply the schema-level minimum (≥1) but reject
      // anything beyond a hard-coded safety floor so that
      // bootstraps which forget to wire the store can't
      // accidentally accept unbounded batches.
      const limit = deps?.configStore?.get('safety.batchWriteLimit') ?? 100;
      if (input.items.length > limit) {
        return err<MementoError>({
          code: 'INVALID_INPUT',
          message: `memory.write_many: batch size ${input.items.length} exceeds safety.batchWriteLimit (${limit})`,
          details: { limit, received: input.items.length },
        });
      }
      // Per-item content/summary/tag caps. We check every item up
      // front so the whole batch fails fast on the first violation
      // — without this, an oversize item N hits the cap mid-
      // transaction and the rollback discards items 0..N-1's work.
      if (deps?.configStore !== undefined) {
        for (let i = 0; i < input.items.length; i += 1) {
          const item = input.items[i];
          if (item === undefined) continue;
          const cap = enforceSafetyCaps(
            'memory.write_many',
            {
              content: item.content,
              summary: item.summary,
              tags: item.tags,
              rationale: rationaleFromKind(item.kind),
            },
            deps.configStore,
            i,
          );
          if (!cap.ok) return cap;
        }
      }
      const defaultPinned = deps?.configStore?.get('write.defaultPinned') ?? false;
      const defaultConfidence = deps?.configStore?.get('write.defaultConfidence') ?? 1;
      const result = await runRepo<readonly { memory: Memory; idempotent: boolean }[]>(
        'memory.write_many',
        () =>
          repo.writeMany(
            input.items.map((item) => ({
              scope: item.scope,
              owner: item.owner,
              kind: item.kind,
              tags: [...item.tags],
              pinned: item.pinned ?? defaultPinned,
              content: item.content,
              summary: item.summary,
              storedConfidence: item.storedConfidence ?? defaultConfidence,
              ...(item.clientToken !== undefined ? { clientToken: item.clientToken } : {}),
              ...(item.sensitive !== undefined ? { sensitive: item.sensitive } : {}),
            })),
            ctxToRepoCtx(ctx),
          ),
      );
      if (!result.ok) {
        return result;
      }
      // Fire afterWrite only for freshly-inserted rows. Items
      // resolved by clientToken idempotency are *not* re-run
      // through the conflict detector — their conflicts (if
      // any) were opened at original-write time.
      let idempotentCount = 0;
      const ids: MemoryId[] = [];
      for (const entry of result.value) {
        ids.push(entry.memory.id);
        if (entry.idempotent) {
          idempotentCount += 1;
        } else {
          fireAfterWrite(hooks, entry.memory, ctx);
        }
      }
      return ok({ ids, idempotentCount });
    },
  };

  const readCommand: Command<typeof MemoryReadInputSchema, typeof MemoryNullableOutputSchema> = {
    name: 'memory.read',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: MemoryReadInputSchema,
    outputSchema: MemoryNullableOutputSchema,
    metadata: {
      description:
        'Fetch a single memory by id, or null if absent. By default the embedding vector is stripped (callers almost never need 768 floats); pass `includeEmbedding: true` for the raw vector.',
    },
    handler: async (input) => {
      const result = await runRepo<Memory | null>('memory.read', () => repo.read(input.id));
      if (!result.ok || result.value === null) {
        return result;
      }
      return ok(
        projectMemoryForOutput(result.value, deps?.configStore, input.includeEmbedding === true),
      );
    },
  };

  const listCommand: Command<typeof MemoryListInputSchema, typeof MemoryListOutputSchema> = {
    name: 'memory.list',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: MemoryListInputSchema,
    outputSchema: MemoryListOutputSchema,
    metadata: {
      description:
        'List memories matching the given filter, newest first.\n\nExamples:\n\n- All active: `{}`\n- Only facts: `{"kind":"fact"}`\n- Pinned in a repo: `{"pinned":true,"scope":{"type":"repo","remote":"github.com/acme/app"}}`',
      mcpName: 'list_memories',
    },
    handler: async (input) => {
      const result = await runRepo<Memory[]>('memory.list', () =>
        repo.list({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      );
      if (!result.ok) {
        return result;
      }
      // ADR-0012 §3: project each row through the redacted view
      // when the privacy config is on. The repository hands us
      // full Memory entities; the projection is purely
      // presentational and never touches the database.
      const redact = deps?.configStore?.get('privacy.redactSensitiveSnippets') ?? false;
      const stripEmbedding = !(input.includeEmbedding === true);
      return ok(
        result.value.map((m) => {
          const view = projectMemoryView(m, redact);
          const embeddingStatus = computeEmbeddingStatus(m, deps?.configStore);
          if (stripEmbedding) {
            return { ...view, embedding: null, embeddingStatus };
          }
          return { ...view, embeddingStatus };
        }),
      );
    },
  };

  const supersedeCommand: Command<typeof MemorySupersedeInputSchema, typeof SupersedeOutputSchema> =
    {
      name: 'memory.supersede',
      sideEffect: 'write',
      surfaces: SURFACES,
      inputSchema: MemorySupersedeInputSchema,
      outputSchema: SupersedeOutputSchema,
      metadata: {
        description:
          'Replace an existing memory with a new one in a single transaction. Use this instead of update when the content changes.\n\nExample:\n\n```json\n{"oldId":"01HYXZ...","next":{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["corrected"],"pinned":false,"content":"Updated fact content.","summary":null,"storedConfidence":0.9}}\n```',
      },
      handler: async (input, ctx) => {
        if (deps?.configStore !== undefined) {
          const cap = enforceSafetyCaps(
            'memory.supersede',
            {
              content: input.next.content,
              summary: input.next.summary,
              tags: input.next.tags,
              rationale: rationaleFromKind(input.next.kind),
            },
            deps.configStore,
          );
          if (!cap.ok) return cap;
        }
        const pinned = input.next.pinned ?? deps?.configStore?.get('write.defaultPinned') ?? false;
        const storedConfidence =
          input.next.storedConfidence ?? deps?.configStore?.get('write.defaultConfidence') ?? 1;
        const result = await runRepo<{ previous: Memory; current: Memory }>(
          'memory.supersede',
          () =>
            // `clientToken` does not apply to supersede (ADR-0012
            // §2) — supersede has its own causality. Strip it
            // from `input.next` even if a caller supplied one.
            repo.supersede(
              input.oldId,
              {
                scope: input.next.scope,
                owner: input.next.owner,
                kind: input.next.kind,
                tags: [...input.next.tags],
                pinned,
                content: input.next.content,
                summary: input.next.summary,
                storedConfidence,
                ...(input.next.sensitive !== undefined ? { sensitive: input.next.sensitive } : {}),
              },
              ctxToRepoCtx(ctx),
            ),
        );
        if (result.ok) {
          // Only `current` is freshly-authored content; the
          // `previous` row is now superseded and will be
          // filtered out by the detector's status check.
          fireAfterWrite(hooks, result.value.current, ctx);
          return ok({
            previous: projectMemoryForOutput(result.value.previous, deps?.configStore, false),
            current: projectMemoryForOutput(result.value.current, deps?.configStore, false),
          });
        }
        return result;
      },
    };

  const confirmCommand: Command<typeof MemoryIdInputSchema, typeof MemoryOutputSchema> = {
    name: 'memory.confirm',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: MemoryIdInputSchema,
    outputSchema: MemoryOutputSchema,
    metadata: {
      description:
        'Re-affirm an active memory (bumps lastConfirmedAt, resetting confidence decay).\n\nExample:\n\n```json\n{"id":"01HYXZ..."}\n```',
    },
    handler: async (input, ctx) => {
      const result = await runRepo<Memory>('memory.confirm', () =>
        repo.confirm(input.id, ctxToRepoCtx(ctx)),
      );
      if (!result.ok) return result;
      return ok(projectMemoryForOutput(result.value, deps?.configStore, false));
    },
  };

  const confirmManyCommand: Command<
    typeof MemoryConfirmManyInputSchema,
    typeof ConfirmManyOutputSchema
  > = {
    name: 'memory.confirm_many',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: MemoryConfirmManyInputSchema,
    outputSchema: ConfirmManyOutputSchema,
    metadata: {
      description:
        'Bulk-confirm multiple active memories in one call (resets confidence decay for each).\n\nExample:\n\n```json\n{"ids":["01HYXZ...","01HYXY..."]}\n```',
      mcpName: 'confirm_many_memories',
    },
    handler: async (input, ctx) => {
      const repoCtx = ctxToRepoCtx(ctx);
      const batchResult = await runRepo<{
        applied: number;
        skippedIds: readonly MemoryId[];
      }>('memory.confirm_many', () => repo.confirmBatch(input.ids, repoCtx));
      if (!batchResult.ok) {
        return err<MementoError>(batchResult.error);
      }
      const failed = batchResult.value.skippedIds.map((id) => ({
        id: String(id),
        code: 'NOT_CONFIRMABLE',
        message: `memory ${String(id)} is not active or does not exist`,
      }));
      return ok({ confirmed: batchResult.value.applied, failed });
    },
  };

  const updateCommand: Command<typeof MemoryUpdateInputSchema, typeof MemoryOutputSchema> = {
    name: 'memory.update',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: MemoryUpdateInputSchema,
    outputSchema: MemoryOutputSchema,
    metadata: {
      description:
        'Update non-content fields (tags / kind / pinned / sensitive) of an active memory. Does NOT change content — use memory.supersede for that.\n\nExample:\n\n```json\n{"id":"01HYXZ...","patch":{"tags":["updated-tag"],"pinned":true}}\n```',
    },
    handler: async (input, ctx) => {
      const result = await runRepo<Memory>('memory.update', () =>
        repo.update(
          input.id,
          {
            ...(input.patch.tags !== undefined ? { tags: [...input.patch.tags] } : {}),
            ...(input.patch.kind !== undefined ? { kind: input.patch.kind } : {}),
            ...(input.patch.pinned !== undefined ? { pinned: input.patch.pinned } : {}),
            ...(input.patch.sensitive !== undefined ? { sensitive: input.patch.sensitive } : {}),
          },
          ctxToRepoCtx(ctx),
        ),
      );
      if (!result.ok) return result;
      return ok(projectMemoryForOutput(result.value, deps?.configStore, false));
    },
  };

  const forgetCommand: Command<typeof MemoryForgetInputSchema, typeof MemoryOutputSchema> = {
    name: 'memory.forget',
    sideEffect: 'destructive',
    surfaces: SURFACES,
    inputSchema: MemoryForgetInputSchema,
    outputSchema: MemoryOutputSchema,
    metadata: {
      description:
        'Soft-remove an active memory; reversible via memory.restore.\n\nExample:\n\n```json\n{"id":"01HYXZ...","reason":"No longer relevant","confirm":true}\n```',
    },
    handler: async (input, ctx) => {
      const result = await runRepo<Memory>('memory.forget', () =>
        repo.forget(input.id, input.reason, ctxToRepoCtx(ctx)),
      );
      if (!result.ok) return result;
      return ok(projectMemoryForOutput(result.value, deps?.configStore, false));
    },
  };

  const restoreCommand: Command<typeof MemoryIdInputSchema, typeof MemoryOutputSchema> = {
    name: 'memory.restore',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: MemoryIdInputSchema,
    outputSchema: MemoryOutputSchema,
    metadata: {
      description:
        'Move a forgotten or archived memory back to active.\n\nExample:\n\n```json\n{"id":"01HYXZ..."}\n```',
    },
    handler: async (input, ctx) => {
      const result = await runRepo<Memory>('memory.restore', () =>
        repo.restore(input.id, ctxToRepoCtx(ctx)),
      );
      if (!result.ok) return result;
      return ok(projectMemoryForOutput(result.value, deps?.configStore, false));
    },
  };

  const archiveCommand: Command<typeof MemoryArchiveInputSchema, typeof MemoryOutputSchema> = {
    name: 'memory.archive',
    sideEffect: 'destructive',
    surfaces: SURFACES,
    inputSchema: MemoryArchiveInputSchema,
    outputSchema: MemoryOutputSchema,
    metadata: {
      description:
        'Move a memory to long-term storage. Idempotent on already-archived rows. Requires confirm: true.\n\nExample:\n\n```json\n{"id":"01HYXZ...","confirm":true}\n```',
      mcp: { idempotentHint: true },
    },
    handler: async (input, ctx) => {
      const result = await runRepo<Memory>('memory.archive', () =>
        repo.archive(input.id, ctxToRepoCtx(ctx)),
      );
      if (!result.ok) return result;
      return ok(projectMemoryForOutput(result.value, deps?.configStore, false));
    },
  };

  const forgetManyCommand: Command<
    typeof MemoryForgetManyInputSchema,
    typeof MemoryBulkResultSchema
  > = {
    name: 'memory.forget_many',
    sideEffect: 'destructive',
    surfaces: SURFACES,
    inputSchema: MemoryForgetManyInputSchema,
    outputSchema: MemoryBulkResultSchema,
    metadata: {
      description:
        'Bulk-soft-remove active memories matching a filter. Requires confirm: true. Defaults to dryRun=true (preview only); set dryRun=false to apply.\n\nExample (dry run):\n\n```json\n{"filter":{"kind":"todo"},"reason":"Completed sprint","confirm":true}\n```',
      mcpName: 'forget_many_memories',
    },
    handler: async (input, ctx) => {
      // Verb fixes the source status: forget targets active.
      const matchedResult = await runRepo<MemoryId[]>('memory.forget_many', () =>
        repo.listIdsForBulk({
          status: 'active',
          ...(input.filter.scope !== undefined ? { scope: input.filter.scope } : {}),
          ...(input.filter.kind !== undefined ? { kind: input.filter.kind } : {}),
          ...(input.filter.pinned !== undefined ? { pinned: input.filter.pinned } : {}),
          ...(input.filter.createdAtLte !== undefined
            ? { createdAtLte: input.filter.createdAtLte }
            : {}),
        }),
      );
      if (!matchedResult.ok) {
        return matchedResult;
      }
      const ids = matchedResult.value;
      if (input.dryRun) {
        return ok({
          dryRun: true,
          matched: ids.length,
          applied: 0,
          idempotent: 0,
          ids,
        });
      }
      // Apply path: gate by the configured cap. Dry-run is
      // uncapped on purpose — its job is to *discover* the
      // overshoot.
      const limit = deps?.configStore?.get('safety.bulkDestructiveLimit') ?? 1000;
      if (ids.length > limit) {
        return err<MementoError>({
          code: 'INVALID_INPUT',
          message: `memory.forget_many: ${ids.length} matched exceeds safety.bulkDestructiveLimit (${limit}); narrow filter or raise limit`,
          details: { limit, matched: ids.length },
        });
      }
      const repoCtx = ctxToRepoCtx(ctx);
      const batchResult = await runRepo<{ applied: number }>('memory.forget_many', () =>
        repo.forgetBatch(ids, input.reason, repoCtx),
      );
      if (!batchResult.ok) {
        return batchResult;
      }
      return ok({
        dryRun: false,
        matched: ids.length,
        applied: batchResult.value.applied,
        idempotent: 0,
        ids,
      });
    },
  };

  const archiveManyCommand: Command<
    typeof MemoryArchiveManyInputSchema,
    typeof MemoryBulkResultSchema
  > = {
    name: 'memory.archive_many',
    sideEffect: 'destructive',
    surfaces: SURFACES,
    inputSchema: MemoryArchiveManyInputSchema,
    outputSchema: MemoryBulkResultSchema,
    metadata: {
      description:
        'Bulk-archive memories matching a filter. Idempotent on already-archived rows. Requires confirm: true. Defaults to dryRun=true (preview only); set dryRun=false to apply.\n\nExample (dry run):\n\n```json\n{"filter":{"kind":"snippet","pinned":false},"confirm":true}\n```',
      mcpName: 'archive_many_memories',
      mcp: { idempotentHint: true },
    },
    handler: async (input, ctx) => {
      // archive is legal from active | forgotten | superseded;
      // already-archived rows are excluded from the match set
      // so `idempotent` reflects within-batch idempotency only.
      //
      // ADR-0017 §3: run the 3 status queries in parallel — they
      // are independent reads against the same snapshot.
      const filterBase = {
        ...(input.filter.scope !== undefined ? { scope: input.filter.scope } : {}),
        ...(input.filter.kind !== undefined ? { kind: input.filter.kind } : {}),
        ...(input.filter.pinned !== undefined ? { pinned: input.filter.pinned } : {}),
        ...(input.filter.createdAtLte !== undefined
          ? { createdAtLte: input.filter.createdAtLte }
          : {}),
      };
      const listResults = await Promise.all(
        (['active', 'forgotten', 'superseded'] as const).map((status) =>
          runRepo<MemoryId[]>('memory.archive_many', () =>
            repo.listIdsForBulk({ status, ...filterBase }),
          ),
        ),
      );
      const matched: MemoryId[] = [];
      for (const r of listResults) {
        if (!r.ok) {
          return r;
        }
        matched.push(...r.value);
      }
      if (input.dryRun) {
        return ok({
          dryRun: true,
          matched: matched.length,
          applied: 0,
          idempotent: 0,
          ids: matched,
        });
      }
      const limit = deps?.configStore?.get('safety.bulkDestructiveLimit') ?? 1000;
      if (matched.length > limit) {
        return err<MementoError>({
          code: 'INVALID_INPUT',
          message: `memory.archive_many: ${matched.length} matched exceeds safety.bulkDestructiveLimit (${limit}); narrow filter or raise limit`,
          details: { limit, matched: matched.length },
        });
      }
      const repoCtx = ctxToRepoCtx(ctx);
      const batchResult = await runRepo<{ applied: number }>('memory.archive_many', () =>
        repo.archiveBatch(matched, repoCtx),
      );
      if (!batchResult.ok) {
        return batchResult;
      }
      return ok({
        dryRun: false,
        matched: matched.length,
        applied: batchResult.value.applied,
        idempotent: 0,
        ids: matched,
      });
    },
  };

  const setEmbeddingCommand: Command<
    typeof MemorySetEmbeddingInputSchema,
    typeof MemoryOutputSchema
  > = {
    name: 'memory.set_embedding',
    sideEffect: 'admin',
    surfaces: SURFACES,
    inputSchema: MemorySetEmbeddingInputSchema,
    outputSchema: MemoryOutputSchema,
    metadata: {
      description:
        'Attach or replace the embedding for an active memory; appends a reembedded event.',
      mcpName: 'set_memory_embedding',
      mcp: { idempotentHint: true },
    },
    handler: async (input, ctx) => {
      const result = await runRepo<Memory>('memory.set_embedding', () =>
        repo.setEmbedding(
          input.id,
          {
            model: input.model,
            dimension: input.dimension,
            vector: [...input.vector],
          },
          ctxToRepoCtx(ctx),
        ),
      );
      if (!result.ok) return result;
      // Operators of this command supplied the vector themselves;
      // echoing it back would just be redundant payload.
      return ok(projectMemoryForOutput(result.value, deps?.configStore, false));
    },
  };

  // Order is the registration order — keep it grouped by side
  // effect (reads, writes, destructives, admin) for readability.
  const eventsCommand:
    | Command<typeof MemoryEventsInputSchema, typeof MemoryEventListOutputSchema>
    | undefined =
    deps?.eventRepository === undefined
      ? undefined
      : (() => {
          const eventRepo = deps.eventRepository as EventRepository;
          return {
            name: 'memory.events',
            sideEffect: 'read',
            surfaces: SURFACES,
            inputSchema: MemoryEventsInputSchema,
            outputSchema: MemoryEventListOutputSchema,
            metadata: {
              description:
                'Read the audit log: events for one memory (ascending) when id is given, otherwise recent events across all memories (descending).',
              mcpName: 'list_memory_events',
            },
            handler: (input) =>
              runRepo<MemoryEvent[]>('memory.events', () => {
                const filter = {
                  ...(input.types !== undefined ? { types: [...input.types] } : {}),
                  ...(input.limit !== undefined ? { limit: input.limit } : {}),
                };
                return input.id === undefined
                  ? eventRepo.listRecent(filter)
                  : eventRepo.listForMemory(input.id, filter);
              }),
          };
        })();

  const commands: AnyCommand[] = [
    readCommand,
    listCommand,
    writeCommand,
    writeManyCommand,
    supersedeCommand,
    confirmCommand,
    confirmManyCommand,
    updateCommand,
    restoreCommand,
    forgetCommand,
    archiveCommand,
    forgetManyCommand,
    archiveManyCommand,
    setEmbeddingCommand,
  ];
  if (eventsCommand !== undefined) {
    // Slot `memory.events` next to the other read commands so
    // surface listings stay grouped by side-effect class.
    commands.splice(2, 0, eventsCommand);
  }
  return Object.freeze(commands);
}

/**
 * Adapter ctx → repo ctx. They are structurally identical at v1
 * but kept separate types so future additions to one do not
 * silently propagate to the other.
 */
function ctxToRepoCtx(ctx: CommandContext): { actor: ActorRef } {
  return { actor: ctx.actor };
}

// Type-only re-exports so test files and adapters can refer to
// the canonical entity shapes without importing two packages.
export type { Memory, MemoryEvent, MemoryView, Tag };

/**
 * Project a `Memory` to the `MemoryView` output shape used by
 * `memory.list` and `memory.search` (ADR-0012 §3). When `redact`
 * is true and the memory is sensitive, `content` is dropped to
 * `null` and `redacted: true` is set; otherwise the full content
 * is preserved with `redacted: false`. Exported so the search
 * command can apply the same projection without duplicating the
 * branch logic.
 */
export function projectMemoryView(memory: Memory, redact: boolean): MemoryView {
  if (redact && memory.sensitive) {
    return { ...memory, content: null, redacted: true };
  }
  return { ...memory, redacted: false };
}

/**
 * Compute the wire-level `embeddingStatus` projection field.
 *
 * The embedder runs asynchronously after a write (or as a
 * dedicated reembed pass), so a freshly-created memory typically
 * has `embedding === null` for a beat or two. Without this field
 * an assistant reading the write response would have to guess
 * whether `null` means "not computed yet," "embedder is off," or
 * "this command stripped the vector for payload size."
 *
 * Pure projection. No I/O. The vector-enabled signal comes from
 * the live `ConfigStore` — reembedding-after-config-flip is
 * outside this command's frame and is handled by `embedding
 * rebuild`.
 */
export function computeEmbeddingStatus(
  memory: Pick<Memory, 'embedding'>,
  configStore: ConfigStore | undefined,
): 'present' | 'pending' | 'disabled' {
  if (memory.embedding !== null) return 'present';
  const vectorEnabled = configStore?.get('retrieval.vector.enabled') ?? false;
  return vectorEnabled ? 'pending' : 'disabled';
}

/**
 * Project a single-memory wire response. Strips the embedding
 * vector by default (callers almost never need 768 floats) and
 * always sets `embeddingStatus` so the consumer can distinguish
 * "stripped for payload size" from "not yet computed" from
 * "vector retrieval is off."
 *
 * `memory.read` opts back in via `includeEmbedding: true` for
 * the rare debugging case. Every other single-memory command
 * (`write`, `update`, `confirm`, `forget`, `archive`, `restore`,
 * `supersede`, `set_embedding`) strips unconditionally — the
 * vector is reachable from `read` if the operator wants it.
 */
function projectMemoryForOutput(
  memory: Memory,
  configStore: ConfigStore | undefined,
  includeEmbedding: boolean,
): Memory {
  const embeddingStatus = computeEmbeddingStatus(memory, configStore);
  if (includeEmbedding) {
    return { ...memory, embeddingStatus };
  }
  return { ...memory, embedding: null, embeddingStatus };
}
