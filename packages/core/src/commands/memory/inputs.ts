// Zod input schemas for the `memory.*` command set.
//
// These describe the *wire* shape — what an MCP client or CLI
// invocation supplies to a command. They sit in front of the
// repository's TypeScript-only input types
// (`MemoryWriteInput`, `MemoryUpdatePatch`, ...) and adapt
// caller-friendly conventions (string tags, pre-normalised
// `MemoryListFilter`) into the repo's stricter shapes.
//
// We intentionally do **not** re-export these from the package
// root or the schema package. They exist for the command
// adapters; downstream consumers should keep going through
// `@psraghuveer/memento-schema` for entity shapes.

import {
  MEMORY_EVENT_TYPES,
  MEMORY_KIND_TYPES,
  MEMORY_STATUSES,
  MemoryIdSchema,
  MemoryKindSchema,
  OwnerRefSchema,
  ScopeSchema,
  TimestampSchema,
} from '@psraghuveer/memento-schema';
import { z } from 'zod';
import { confirmGate } from '../confirm-gate.js';

/**
 * Input for `memory.write`.
 *
 * `tags` is `string[]` rather than the branded `Tag[]` because
 * the repository normalises tags (trim, lowercase, dedupe) on
 * ingest. Forcing callers to pre-normalise would push an
 * implementation detail of the schema layer onto every adapter.
 */
export const MemoryWriteInputSchema = z
  .object({
    scope: ScopeSchema.describe(
      'Where this memory lives. Discriminated by "type". Use {"type":"global"} for universal memories, {"type":"repo","remote":"github.com/owner/repo"} for repo-scoped, or {"type":"workspace","path":"/absolute/path"} for workspace-scoped.',
    ),
    owner: OwnerRefSchema.default({ type: 'local', id: 'self' }).describe(
      'Who owns this memory. Defaults to {"type":"local","id":"self"} if omitted. In single-user mode this is the only valid value.',
    ),
    kind: MemoryKindSchema.describe(
      'What kind of memory this is. Discriminated by "type". Options: {"type":"fact"}, {"type":"preference"}, {"type":"decision","rationale":"..."}, {"type":"todo","due":null}, {"type":"snippet","language":"typescript"}.',
    ),
    tags: z
      .array(z.string())
      .describe(
        'Freeform tags for categorisation. Normalised to lowercase on ingest. Example: ["project:memento", "architecture"].',
      ),
    pinned: z
      .boolean()
      .optional()
      .describe(
        'If true, this memory is exempt from confidence decay and will never auto-archive. Defaults to the write.defaultPinned config value (false) when omitted.',
      ),
    content: z
      .string()
      .min(1)
      .describe('The memory content — the actual information to remember. Must be non-empty.'),
    summary: z
      .string()
      .nullable()
      .default(null)
      .describe(
        'A short summary of the content for display in listings. Defaults to null if omitted.',
      ),
    storedConfidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'How confident this memory is, from 0.0 to 1.0. Decays over time unless confirmed. Defaults to the write.defaultConfidence config value (1.0) when omitted.',
      ),
    clientToken: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Optional idempotency token. If a memory with the same (scope, clientToken) already exists and is active, the existing id is returned without creating a duplicate.',
      ),
    sensitive: z
      .boolean()
      .optional()
      .describe(
        'Optional privacy flag. When true, content may be redacted in listings if privacy.redactSensitiveSnippets is enabled. Defaults to false.',
      ),
  })
  .strict();

export type MemoryWriteInput = z.infer<typeof MemoryWriteInputSchema>;

/**
 * Input for `memory.write_many`. Carries an array of
 * {@link MemoryWriteInputSchema} items — at least one. The
 * upper bound is enforced at handler time against the
 * `safety.batchWriteLimit` config key (ADR-0012 §4) rather
 * than baked in here, so operators can tune it without a
 * schema change.
 */
export const MemoryWriteManyInputSchema = z
  .object({
    items: z.array(MemoryWriteInputSchema).min(1),
  })
  .strict();

/**
 * Input for `memory.read`. Strict object so unknown keys are a
 * loud `INVALID_INPUT` rather than silently ignored.
 */
export const MemoryReadInputSchema = z
  .object({
    id: MemoryIdSchema.describe('The ULID of the memory to read.'),
  })
  .strict();

/**
 * Input for `memory.list`. Mirrors `MemoryListFilter` from the
 * repository, except that scope is a single optional value (the
 * repo also accepts a list, but exposing the OR-array on the
 * MCP / CLI surface conflicts with `memory.search` semantics —
 * keep it single here, callers compose lists via
 * `effectiveScopes`).
 */
export const MemoryListInputSchema = z
  .object({
    status: z
      .enum(MEMORY_STATUSES)
      .optional()
      .describe(
        'Filter by status: "active", "superseded", "forgotten", or "archived". Omit for all.',
      ),
    kind: z
      .enum(MEMORY_KIND_TYPES)
      .optional()
      .describe(
        'Filter by kind type: "fact", "preference", "decision", "todo", or "snippet". Omit for all.',
      ),
    tags: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Filter to memories containing ALL of these tags (AND logic). Tags are normalised to lowercase. Example: ["project:memento","architecture"].',
      ),
    pinned: z.boolean().optional().describe('Filter by pinned status. Omit for all.'),
    scope: ScopeSchema.optional().describe(
      'Filter by scope. Same shape as memory.write scope. Omit to list across all scopes.',
    ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of memories to return. Omit for server default.'),
  })
  .strict();

/**
 * Input for `memory.supersede`. Carries the old id alongside the
 * full new-memory write input.
 */
export const MemorySupersedeInputSchema = z
  .object({
    oldId: MemoryIdSchema.describe('The ULID of the memory being replaced.'),
    next: MemoryWriteInputSchema.describe(
      'The full new memory to create (same shape as memory.write input). It will link back to oldId.',
    ),
  })
  .strict();

/**
 * Input for `memory.confirm`, `memory.restore`, `memory.archive`.
 * All three take just the id and emit through the same
 * single-id command shape.
 */
export const MemoryIdInputSchema = z
  .object({
    id: MemoryIdSchema.describe('The ULID of the target memory.'),
  })
  .strict();

/**
 * Input for `memory.confirm_many`. Accepts an array of memory
 * ids to re-affirm in a single call. Each id is confirmed
 * independently; failures on one id do not block others. The
 * output reports which ids succeeded and which failed.
 */
export const MemoryConfirmManyInputSchema = z
  .object({
    ids: z
      .array(MemoryIdSchema)
      .min(1)
      .max(100)
      .describe('Array of memory ULIDs to confirm. 1–100 items.'),
  })
  .strict();

/**
 * Input for `memory.update`. The repo's contract is "patch must
 * change at least one field"; we mirror that as a Zod refine so
 * the violation surfaces as `INVALID_INPUT` (with an actionable
 * issue path) before we ever touch the database.
 */
export const MemoryUpdateInputSchema = z
  .object({
    id: MemoryIdSchema.describe('The ULID of the memory to update.'),
    patch: z
      .object({
        tags: z
          .array(z.string())
          .optional()
          .describe('New tags to replace existing tags. Omit to leave unchanged.'),
        kind: MemoryKindSchema.optional().describe(
          'New kind. Same shape as memory.write kind. Omit to leave unchanged.',
        ),
        pinned: z.boolean().optional().describe('New pinned status. Omit to leave unchanged.'),
        sensitive: z.boolean().optional().describe('New sensitive flag. Omit to leave unchanged.'),
      })
      .strict()
      .describe(
        'Patch object — must contain at least one field. Only non-content fields can be updated; to change content, use memory.supersede.',
      )
      .refine(
        (p) =>
          p.tags !== undefined ||
          p.kind !== undefined ||
          p.pinned !== undefined ||
          p.sensitive !== undefined,
        {
          message: 'patch must change at least one field',
        },
      ),
  })
  .strict();

/**
 * Input for `memory.forget`. `reason` is nullable free text;
 * the event schema caps it at 512 chars, mirrored here so the
 * cap fails at the input boundary, not deep in repo code.
 *
 * `confirm: z.literal(true)` is the safety gate from
 * ADR-0012. It is invariant per AGENTS.md rule 12 — there is
 * no deployment mode where a silent forget is acceptable.
 */
export const MemoryForgetInputSchema = z
  .object({
    id: MemoryIdSchema.describe('The ULID of the memory to forget.'),
    reason: z
      .string()
      .max(512)
      .nullable()
      .describe('Why this memory is being forgotten. Pass null if no reason.'),
    confirm: confirmGate().describe('Safety gate — must be true to proceed.'),
  })
  .strict();

/**
 * Input for `memory.archive`. Distinct from `MemoryIdInputSchema`
 * because archive is destructive and gated by `confirm` per
 * ADR-0012, while `memory.confirm` and `memory.restore` are
 * recoverable single-id operations that share the bare
 * `MemoryIdInputSchema`.
 */
export const MemoryArchiveInputSchema = z
  .object({
    id: MemoryIdSchema.describe('The ULID of the memory to archive.'),
    confirm: confirmGate().describe('Safety gate — must be true to proceed.'),
  })
  .strict();

/**
 * Filter accepted by the bulk-destructive verbs
 * (`memory.forget_many`, `memory.archive_many`) per ADR-0014.
 *
 * Strict subset of `MemoryListFilter`: `scope`, `kind`,
 * `pinned`, and `createdAtLte` (inclusive upper bound on
 * `createdAt`). `status` is intentionally **not** here — each
 * verb fixes the legal source statuses itself (forget_many
 * targets `active`, archive_many targets the union of `active`,
 * `forgotten`, `superseded`). At least one field must be set
 * — the empty filter is rejected at parse time so callers
 * cannot accidentally bulk-destroy the whole store.
 */
export const MemoryBulkFilterSchema = z
  .object({
    scope: ScopeSchema.optional().describe('Narrow to a specific scope.'),
    kind: z
      .enum(MEMORY_KIND_TYPES)
      .optional()
      .describe(
        'Narrow to a specific kind: "fact", "preference", "decision", "todo", or "snippet".',
      ),
    pinned: z
      .boolean()
      .optional()
      .describe('Narrow to pinned (true) or unpinned (false) memories.'),
    createdAtLte: TimestampSchema.optional().describe(
      'Only include memories created at or before this timestamp. ISO-8601 UTC.',
    ),
  })
  .strict()
  .describe(
    'Filter for bulk operations. At least one field must be set to prevent accidental mass operations.',
  )
  .refine(
    (f) =>
      f.scope !== undefined ||
      f.kind !== undefined ||
      f.pinned !== undefined ||
      f.createdAtLte !== undefined,
    {
      message:
        'bulk-destructive filter must narrow by at least one of scope, kind, pinned, createdAtLte',
    },
  );

/**
 * Input for `memory.forget_many` (ADR-0014).
 *
 * - `filter` selects active memories to soft-remove.
 * - `reason` is recorded on every per-row `forgotten` event,
 *   capped at 512 chars to mirror the single-row schema.
 * - `dryRun` defaults to `true`: the safe default is the
 *   rehearsal, not the action.
 * - `confirm: z.literal(true)` is required even in dry-run —
 *   the destructive-verb invariant from ADR-0012 §1 does not
 *   relax under rehearsal.
 */
export const MemoryForgetManyInputSchema = z
  .object({
    filter: MemoryBulkFilterSchema.describe('Filter selecting which memories to forget.'),
    reason: z
      .string()
      .max(512)
      .nullable()
      .describe('Reason for forgetting, applied to each affected memory. Pass null if no reason.'),
    dryRun: z
      .boolean()
      .default(true)
      .describe('If true (default), only previews what would be forgotten without acting.'),
    confirm: confirmGate().describe('Safety gate — must be true to proceed.'),
  })
  .strict();

/**
 * Input for `memory.archive_many` (ADR-0014). Same shape as
 * forget_many minus `reason` (archive carries no reason
 * payload in `MemoryEventSchema`).
 */
export const MemoryArchiveManyInputSchema = z
  .object({
    filter: MemoryBulkFilterSchema.describe('Filter selecting which memories to archive.'),
    dryRun: z
      .boolean()
      .default(true)
      .describe('If true (default), only previews what would be archived without acting.'),
    confirm: confirmGate().describe('Safety gate — must be true to proceed.'),
  })
  .strict();

/**
 * Input for `memory.setEmbedding`. The wire shape carries
 * `model`, `dimension`, `vector`; the repo stamps `createdAt`
 * and re-validates against the full `EmbeddingSchema` (which
 * also enforces `vector.length === dimension`).
 *
 * We restate the per-field constraints rather than reach into
 * `EmbeddingSchema._def`. The repository re-parses through
 * `EmbeddingSchema` on the way in, which is the canonical
 * source of truth — this layer just gives an early, clear
 * `INVALID_INPUT` for obviously malformed wire payloads
 * before the repo runs.
 */
export const MemorySetEmbeddingInputSchema = z
  .object({
    id: MemoryIdSchema.describe('The ULID of the memory to attach an embedding to.'),
    model: z
      .string()
      .min(1)
      .max(128)
      .describe('Embedding model name. Example: "bge-small-en-v1.5".'),
    dimension: z
      .number()
      .int()
      .positive()
      .max(4096)
      .describe('Vector dimension. Must match vector array length. Example: 384.'),
    vector: z
      .array(z.number().finite())
      .describe('The embedding vector as an array of finite floats. Length must equal dimension.'),
  })
  .strict();

/**
 * Input for `memory.events`.
 *
 * Two modes share one command so the CLI / MCP surface stays
 * compact: when `id` is supplied the audit log of that memory
 * is returned in commit order (ascending event id); when `id`
 * is omitted the cross-memory tail of the log is returned
 * newest-first. Both modes accept the same `types` filter and
 * `limit`. The repository clamps `limit` against
 * `events.list.maxLimit`; values above the cap are silently
 * truncated rather than rejected, matching `memory.list`.
 */
export const MemoryEventsInputSchema = z
  .object({
    id: MemoryIdSchema.optional().describe(
      'Optional memory ULID. If provided, returns events for that memory in commit order. If omitted, returns the cross-memory event tail newest-first.',
    ),
    types: z
      .array(z.enum(MEMORY_EVENT_TYPES))
      .nonempty()
      .optional()
      .describe('Filter to specific event types. Omit for all event types.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum events to return. Server clamps to configured max.'),
  })
  .strict();
