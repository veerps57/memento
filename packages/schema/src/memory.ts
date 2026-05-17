import { z } from 'zod';
import { OwnerRefSchema } from './actors.js';
import { MemoryIdSchema, TagSchema, TimestampSchema } from './primitives.js';
import { ScopeSchema } from './scope.js';

/**
 * The current schema version. Bumped when the on-disk shape of a
 * `Memory` changes in a way that requires a migration. Stored on
 * every memory so individual rows can be migrated forward without
 * a global "stop the world" rewrite.
 */
export const MEMORY_SCHEMA_VERSION = 1;

/**
 * `MemoryKind` is the taxonomic discriminator for a memory. Each
 * variant carries the kind-specific fields it needs (and only
 * those). The set is closed: adding a kind is an ADR + migration.
 *
 * - `fact`       — assertion about the world or codebase.
 * - `preference` — user preference that should bias future actions.
 * - `decision`   — chosen path among alternatives, with optional
 *                   rationale for "why not the others?".
 * - `todo`       — an action item, with an optional due timestamp.
 * - `snippet`    — a reusable code fragment, with an optional
 *                   language hint for syntax-aware retrieval.
 */
export const MemoryKindSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('fact') })
    .strict()
    .describe('A factual assertion. Example: {"type":"fact"}'),
  z
    .object({ type: z.literal('preference') })
    .strict()
    .describe('A user preference that should bias future actions. Example: {"type":"preference"}'),
  z
    .object({
      type: z.literal('decision'),
      rationale: z
        .string()
        .nullable()
        .describe('Why this decision was made and alternatives rejected. Null if not provided.'),
    })
    .strict()
    .describe(
      'A chosen path among alternatives. Example: {"type":"decision","rationale":"Chose SQLite for simplicity"}',
    ),
  z
    .object({
      type: z.literal('todo'),
      due: TimestampSchema.nullable().describe(
        'Optional due date as ISO-8601 UTC timestamp, or null. Example: "2025-06-01T00:00:00.000Z"',
      ),
    })
    .strict()
    .describe('An action item. Example: {"type":"todo","due":null}'),
  z
    .object({
      type: z.literal('snippet'),
      language: z
        .string()
        .min(1)
        .max(64)
        .nullable()
        .describe(
          'Programming language hint for syntax-aware retrieval, or null. Example: "typescript"',
        ),
    })
    .strict()
    .describe('A reusable code fragment. Example: {"type":"snippet","language":"typescript"}'),
]);

export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MEMORY_KIND_TYPES = ['fact', 'preference', 'decision', 'todo', 'snippet'] as const;
export type MemoryKindType = (typeof MEMORY_KIND_TYPES)[number];

/**
 * `MemoryStatus` is the lifecycle state of a memory. Transitions are
 * driven by named commands; there is no path to flip status via
 * `memory.update`. The schema only validates the value set; the
 * repository enforces the transition graph.
 */
export const MEMORY_STATUSES = ['active', 'superseded', 'forgotten', 'archived'] as const;
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

/**
 * `Embedding` is a vector representation of a memory's content,
 * produced by a local embedder. Stored alongside the memory iff
 * `retrieval.vector.enabled` was true at write/embed time.
 *
 * The `model` and `dimension` are stored explicitly so that swapping
 * the embedder model is detectable (different `model` ⇒ rebuild
 * required). The vector is an array of finite floats; bit-exact
 * stability is not assumed across embedder versions.
 */
export const EmbeddingSchema = z
  .object({
    model: z.string().min(1).max(128),
    dimension: z.number().int().positive().max(4096),
    vector: z.array(z.number().finite()),
    createdAt: TimestampSchema,
  })
  .strict()
  .refine((e) => e.vector.length === e.dimension, {
    message: 'Embedding.vector.length must equal Embedding.dimension',
    path: ['vector'],
  });

export type Embedding = z.infer<typeof EmbeddingSchema>;

const MemoryBaseSchema = z
  .object({
    // Immutable identity
    id: MemoryIdSchema,
    createdAt: TimestampSchema,
    schemaVersion: z.number().int().positive(),
    scope: ScopeSchema,

    // Owner
    owner: OwnerRefSchema,

    // Mutable taxonomy
    kind: MemoryKindSchema,
    tags: z.array(TagSchema),
    pinned: z.boolean(),

    // Content
    content: z.string().min(1),
    summary: z.string().nullable(),

    // Lifecycle
    status: MemoryStatusSchema,
    storedConfidence: z.number().min(0).max(1),
    lastConfirmedAt: TimestampSchema,

    // Relationships
    supersedes: MemoryIdSchema.nullable(),
    supersededBy: MemoryIdSchema.nullable(),

    // Optional embedding
    embedding: EmbeddingSchema.nullable(),

    /**
     * Privacy flag (ADR-0012 §3). When `true`, `memory.list` and
     * `memory.search` outputs may project this memory through
     * {@link RedactedMemoryViewSchema} (content → null,
     * `redacted: true`) if `privacy.redactSensitiveSnippets` is
     * enabled. `memory.read` always returns the full text
     * regardless of this flag — reading by id is an explicit,
     * scoped request.
     *
     * Defaults to `false` when omitted from a write input so the
     * vast majority of test fixtures and call sites stay
     * unchanged.
     */
    sensitive: z.boolean().default(false),

    /**
     * Wire-level signal of embedding state. Optional because the
     * storage / repository layers do not produce it — it's
     * computed at the command-output projection boundary by
     * {@link projectMemoryForOutput} so an assistant reading a
     * single-memory response can tell whether the vector is:
     *
     * - `'present'` — embedding row exists AND its `model` /
     *   `dimension` match the configured embedding provider.
     *   The vector arm of the ranker will use it.
     * - `'stale'` — embedding row exists but `model` /
     *   `dimension` mismatch the configured provider. The vector
     *   arm skips it; `memento embedding rebuild` will re-embed
     *   it on the next pass.
     * - `'pending'` — no embedding row yet; vector retrieval is
     *   enabled but the embedder hasn't caught up. Common for
     *   ~milliseconds right after `memory.write`.
     * - `'disabled'` — `retrieval.vector.enabled` is `false`.
     *
     * The field is also why the wire output now strips the raw
     * vector by default: callers that need to know "is there a
     * usable embedding?" no longer have to inspect 768 floats.
     */
    embeddingStatus: z.enum(['present', 'stale', 'pending', 'disabled']).optional(),
  })
  .strict();

/**
 * `Memory` is the canonical entity. Schema-level invariants
 * enforced here (the repository enforces cross-record invariants
 * such as bidirectional supersession in the same transaction):
 *
 * - `lastConfirmedAt >= createdAt` — denormalised cache of
 *   `MAX(MemoryEvent.at)`, must never precede creation.
 * - `status === 'superseded'` ⇒ `supersededBy !== null`.
 * - `supersededBy !== null` ⇒ `status === 'superseded'`.
 *
 * Identity fields (`id`, `createdAt`, `schemaVersion`, `scope`) are
 * immutable post-creation; mutation is enforced at the repository
 * layer because Zod schemas operate on values, not transitions.
 */
export const MemorySchema = MemoryBaseSchema.refine((m) => m.lastConfirmedAt >= m.createdAt, {
  message: 'lastConfirmedAt must be >= createdAt',
  path: ['lastConfirmedAt'],
})
  .refine((m) => m.status !== 'superseded' || m.supersededBy !== null, {
    message: 'status=superseded requires a non-null supersededBy',
    path: ['supersededBy'],
  })
  .refine((m) => m.supersededBy === null || m.status === 'superseded', {
    message: 'supersededBy is only valid when status=superseded',
    path: ['status'],
  });

export type Memory = z.infer<typeof MemorySchema>;

/**
 * `MemoryView` is the *output* projection used by `memory.list`
 * and `memory.search` (ADR-0012 §3). It is a discriminated
 * union on `redacted`:
 *
 * - `redacted: false` — every field of {@link MemorySchema} is
 *   present; `content` is the original string. Behaves
 *   identically to a plain `Memory` for downstream consumers.
 * - `redacted: true`  — `content` is `null`; every other field
 *   (id, scope, createdAt, tags, kind, …) is preserved so the
 *   assistant can offer the user a "show full content"
 *   follow-up via `memory.read`.
 *
 * The repository never returns this shape directly; it is
 * produced at the command-layer projection boundary (see
 * `redactView()` in core). The cross-field refines on
 * `MemorySchema` (`lastConfirmedAt >= createdAt`,
 * status/supersededBy pairing) are not duplicated here because
 * the input is always a previously-validated `Memory`.
 */
const FullMemoryViewSchema = MemoryBaseSchema.extend({
  redacted: z.literal(false),
}).strict();

const RedactedMemoryViewSchema = MemoryBaseSchema.extend({
  content: z.null(),
  redacted: z.literal(true),
}).strict();

export const MemoryViewSchema = z.discriminatedUnion('redacted', [
  FullMemoryViewSchema,
  RedactedMemoryViewSchema,
]);

export type MemoryView = z.infer<typeof MemoryViewSchema>;
