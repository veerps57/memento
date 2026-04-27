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
    scope: ScopeSchema,
    owner: OwnerRefSchema,
    kind: MemoryKindSchema,
    tags: z.array(z.string()),
    pinned: z.boolean(),
    content: z.string().min(1),
    summary: z.string().nullable(),
    storedConfidence: z.number().min(0).max(1),
    /**
     * Per-scope idempotency token (ADR-0012 §2). When supplied,
     * a second `memory.write` with the same `(scope, clientToken)`
     * while the first memory is still `active` returns the
     * existing memory id without inserting a new row or audit
     * event. Tokens are freed when the memory is forgotten.
     */
    clientToken: z.string().min(1).max(128).optional(),
    /**
     * Privacy flag (ADR-0012 §3). When true the memory is
     * marked `sensitive`; `memory.list` and `memory.search`
     * may then project it through the redacted view if
     * `privacy.redactSensitiveSnippets` is on. Defaults to
     * `false` when omitted.
     */
    sensitive: z.boolean().optional(),
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
    id: MemoryIdSchema,
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
    status: z.enum(MEMORY_STATUSES).optional(),
    kind: z.enum(MEMORY_KIND_TYPES).optional(),
    pinned: z.boolean().optional(),
    scope: ScopeSchema.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Input for `memory.supersede`. Carries the old id alongside the
 * full new-memory write input.
 */
export const MemorySupersedeInputSchema = z
  .object({
    oldId: MemoryIdSchema,
    next: MemoryWriteInputSchema,
  })
  .strict();

/**
 * Input for `memory.confirm`, `memory.restore`, `memory.archive`.
 * All three take just the id and emit through the same
 * single-id command shape.
 */
export const MemoryIdInputSchema = z
  .object({
    id: MemoryIdSchema,
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
    id: MemoryIdSchema,
    patch: z
      .object({
        tags: z.array(z.string()).optional(),
        kind: MemoryKindSchema.optional(),
        pinned: z.boolean().optional(),
        sensitive: z.boolean().optional(),
      })
      .strict()
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
    id: MemoryIdSchema,
    reason: z.string().max(512).nullable(),
    confirm: z.literal(true, {
      errorMap: () => ({
        message: 'this operation is destructive; pass { confirm: true } to proceed',
      }),
    }),
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
    id: MemoryIdSchema,
    confirm: z.literal(true, {
      errorMap: () => ({
        message: 'this operation is destructive; pass { confirm: true } to proceed',
      }),
    }),
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
    scope: ScopeSchema.optional(),
    kind: z.enum(MEMORY_KIND_TYPES).optional(),
    pinned: z.boolean().optional(),
    createdAtLte: TimestampSchema.optional(),
  })
  .strict()
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
    filter: MemoryBulkFilterSchema,
    reason: z.string().max(512).nullable(),
    dryRun: z.boolean().default(true),
    confirm: z.literal(true, {
      errorMap: () => ({
        message: 'this operation is destructive; pass { confirm: true } to proceed',
      }),
    }),
  })
  .strict();

/**
 * Input for `memory.archive_many` (ADR-0014). Same shape as
 * forget_many minus `reason` (archive carries no reason
 * payload in `MemoryEventSchema`).
 */
export const MemoryArchiveManyInputSchema = z
  .object({
    filter: MemoryBulkFilterSchema,
    dryRun: z.boolean().default(true),
    confirm: z.literal(true, {
      errorMap: () => ({
        message: 'this operation is destructive; pass { confirm: true } to proceed',
      }),
    }),
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
    id: MemoryIdSchema,
    model: z.string().min(1).max(128),
    dimension: z.number().int().positive().max(4096),
    vector: z.array(z.number().finite()),
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
    id: MemoryIdSchema.optional(),
    types: z.array(z.enum(MEMORY_EVENT_TYPES)).nonempty().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
