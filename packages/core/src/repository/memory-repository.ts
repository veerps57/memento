// MemoryRepository — write / read / list operations against the
// `memories` table, with the corresponding `created` events appended
// atomically to `memory_events`. Supersession and the
// confirm/forget/restore/archive transitions are layered on in a
// follow-up commit.
//
// Design choices:
//
// - The repository is *the* gatekeeper for current-state writes.
//   Every successful `write` returns a `Memory` parsed by
//   `MemorySchema`, so callers cannot observe a row that violates
//   the schema invariants.
// - Repository-managed fields (`id`, `createdAt`, `schemaVersion`,
//   `lastConfirmedAt`, `status`, `supersedes`, `supersededBy`,
//   `embedding`) are not part of the input shape. The repo assigns
//   them: status starts at `active`, lastConfirmedAt = createdAt,
//   schemaVersion = MEMORY_SCHEMA_VERSION, supersession pointers
//   are null on a fresh write.
// - Tags are normalised at the schema layer (via `TagSchema`), so
//   the repo only has to dedupe and sort them for stable equality.
//   Sorted tags also make any future tag-array equality test cheap.
// - The transaction wraps both the `memories` insert and the
//   `created` event insert. SQLite + better-sqlite3 transactions
//   are synchronous; we model that through Kysely's
//   `db.transaction().execute(cb)` whose body is `async` but the
//   underlying driver is synchronous, so failures roll back.

import {
  type ActorRef,
  CONFIG_KEYS,
  type Embedding,
  EmbeddingSchema,
  MEMORY_SCHEMA_VERSION,
  type Memory,
  type MemoryEvent,
  MemoryEventSchema,
  type MemoryId,
  type MemoryKind,
  MemorySchema,
  type OwnerRef,
  type Scope,
  type ScrubReport,
  type ScrubberRuleSet,
  type Tag,
  TagSchema,
  type Timestamp,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { applyRules } from '../scrubber/engine.js';
import type { MementoSchema, MemoriesTable, MemoryEventsTable } from '../storage/schema.js';
import { ulid } from './ulid.js';

/**
 * Input shape for {@link MemoryRepository.write}.
 *
 * The fields that the repository assigns are absent here: callers
 * cannot specify the id, timestamps, status, or supersession links.
 * `tags` accepts plain strings — they are normalised through
 * `TagSchema` before insertion, so callers do not have to lower-case
 * or dedupe up-front.
 */
export interface MemoryWriteInput {
  readonly scope: Scope;
  readonly owner: OwnerRef;
  readonly kind: MemoryKind;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly content: string;
  readonly summary: string | null;
  readonly storedConfidence: number;
  /**
   * Optional per-scope idempotency token (ADR-0012 §2). When
   * supplied, a duplicate write with the same `(scope, token)`
   * while the first memory is still `active` returns the existing
   * row instead of inserting. Bounds (1..128 chars) are enforced
   * by the command-layer schema; the repository treats any
   * defined string as opaque.
   */
  readonly clientToken?: string;
  /**
   * Optional privacy flag (ADR-0012 §3). When `true` the memory
   * is stored with `sensitive=1`; `memory.list` and
   * `memory.search` may then project it through the redacted
   * view if `privacy.redactSensitiveSnippets` is on. Defaults to
   * `false` when omitted, matching the entity-level default in
   * `MemorySchema`.
   */
  readonly sensitive?: boolean;
}

/**
 * Filter accepted by {@link MemoryRepository.list}. All fields are
 * optional and AND together. The default ordering is
 * `last_confirmed_at desc, id desc` so list results are stable and
 * reproducible regardless of write interleaving.
 *
 * `scope` accepts a single {@link Scope} or an array; the latter
 * matches if the row's scope equals **any** of the supplied
 * scopes (an OR over equality, not a layered read). Pass the
 * output of `resolveEffectiveScopes` here to apply the layered
 * read at the SQL boundary. Equality is on `(scope_type,
 * scope_json)` — `scope_json` is the canonical, stable
 * stringification produced at write time.
 */
export interface MemoryListFilter {
  readonly status?: 'active' | 'superseded' | 'forgotten' | 'archived';
  readonly kind?: MemoryKind['type'];
  readonly pinned?: boolean;
  readonly scope?: Scope | readonly Scope[];
  /**
   * Inclusive lower bound on `createdAt` (ISO timestamp). Used
   * by `conflict.scan` in `since` mode to re-run detection over
   * a historical window. Comparison is lexicographic on the ISO
   * string, which is monotonically equivalent to chronological
   * order for our `TimestampSchema` shape.
   */
  readonly createdAtGte?: Timestamp;
  /**
   * Inclusive upper bound on `createdAt` (ISO timestamp).
   * Used by the bulk-destructive verbs (ADR-0014) to scope
   * "older than" sweeps. Same lexicographic-on-ISO comparison
   * as `createdAtGte`.
   */
  readonly createdAtLte?: Timestamp;
  readonly limit?: number;
}

export interface MemoryRepository {
  write(input: MemoryWriteInput, ctx: { actor: ActorRef }): Promise<Memory>;
  /**
   * Batch counterpart to {@link write}. All inserts run inside
   * a single transaction: if any item's `INSERT` fails (FK
   * violation, schema parse error, scrubber explosion, ...) the
   * whole batch rolls back. Per-item idempotency is preserved —
   * items carrying a `clientToken` that hits an existing active
   * memory are returned as `idempotent: true` *without*
   * inserting a row or appending an audit event, even when
   * mixed alongside fresh inserts in the same call.
   *
   * Order of the returned array matches the input order.
   * Empty input returns an empty array (no transaction opened).
   */
  writeMany(
    inputs: readonly MemoryWriteInput[],
    ctx: { actor: ActorRef },
  ): Promise<readonly { memory: Memory; idempotent: boolean }[]>;
  read(id: MemoryId): Promise<Memory | null>;
  /**
   * Hydrate a batch of memories by id in a single round-trip.
   * Order is **not** preserved — callers that need a specific
   * order (e.g. retrieval ranking) should re-sort by `id` against
   * their candidate list. Missing ids are silently dropped; this
   * matches the `read` semantics where a missing id is null
   * rather than an error, and prevents a stale candidate from
   * tripping the whole search.
   */
  readMany(ids: readonly MemoryId[]): Promise<Memory[]>;
  list(filter?: MemoryListFilter): Promise<Memory[]>;
  /**
   * Bulk-destructive helper (ADR-0014). Returns the **ids** of
   * every memory matching the filter, with no clamping by
   * `memory.list.maxLimit`. Used by `memory.forget_many` and
   * `memory.archive_many` to compute the true `matched` count
   * for both the dry-run report and the `safety.bulkDestructiveLimit`
   * cap check. Not exposed on the public read surface — full
   * `Memory` enumeration over an unbounded result set is not a
   * supported pattern; this returns ids only so callers cannot
   * accidentally use it for paging.
   */
  listIdsForBulk(filter: MemoryListFilter): Promise<MemoryId[]>;
  /**
   * Replace `oldId` with a new memory in a single transaction.
   *
   * Pre-conditions:
   * - the old memory exists;
   * - the old memory has `status === 'active'` (you cannot supersede
   *   a memory that has already been superseded, forgotten, or
   *   archived).
   *
   * The implementation uses a conditional UPDATE so the
   *  `oldId.supersededBy IS NULL` check + the assignment happen
   * in one statement: a racing supersede sees zero rows affected
   * and gets a clear error rather than silently overwriting the
   * winner's `supersededBy` pointer.
   */
  supersede(
    oldId: MemoryId,
    newInput: MemoryWriteInput,
    ctx: { actor: ActorRef },
  ): Promise<{ previous: Memory; current: Memory }>;
  /**
   * Re-affirm that a memory is still correct. Sets
   * `lastConfirmedAt = now` and emits a `confirmed` event. Only
   * legal on `active` memories — confirming a forgotten or
   * archived memory is a category error (use `restore` first).
   */
  confirm(id: MemoryId, ctx: { actor: ActorRef }): Promise<Memory>;
  /**
   * Mutate the *taxonomy* of a memory: any combination of
   * `tags`, `kind`, `pinned`. Content changes go through
   * {@link MemoryRepository.supersede}; this method rejects them
   * by signature alone. The patch must be non-empty.
   */
  update(id: MemoryId, patch: MemoryUpdatePatch, ctx: { actor: ActorRef }): Promise<Memory>;
  /**
   * Soft-remove from active retrieval. Only legal on active
   * memories. Reason is optional free text (capped by the event
   * schema).
   */
  forget(id: MemoryId, reason: string | null, ctx: { actor: ActorRef }): Promise<Memory>;
  /**
   * Move a non-active memory back to `active`. Legal source
   * statuses are `forgotten` and `archived` — the two
   * reversible transitions out of `active`. (Supersession is
   * not reversible: it links forward to a replacement memory,
   * which carries the corrected content; restoring would
   * silently un-do that link.)
   *
   * Both source paths emit a `'restored'` event — the event's
   * meaning is "moved back to active", which holds regardless
   * of which sink the row was in. This keeps the audit log
   * narrow (no separate `'unarchived'` event type) while
   * preserving the full transition history: the immediately
   * preceding `'archived'` or `'forgotten'` event is right
   * there in the same log.
   */
  restore(id: MemoryId, ctx: { actor: ActorRef }): Promise<Memory>;
  /**
   * Move a memory to long-term storage. Legal from active,
   * forgotten, or superseded. Idempotent: archiving an already-
   * archived memory is a no-op rather than an error so callers
   * can run "archive everything I touched" passes.
   */
  archive(id: MemoryId, ctx: { actor: ActorRef }): Promise<Memory>;
  /**
   * Attach (or replace) the embedding for an active memory and
   * append a `reembedded` event in the same transaction. The
   * input carries `model`, `dimension`, and `vector`; the repo
   * stamps `createdAt` from its clock and validates the row
   * through {@link EmbeddingSchema} (which enforces
   * `vector.length === dimension`) before writing.
   *
   * Legal only on `active` memories: vector retrieval is over
   * `active` rows (see `docs/architecture/retrieval.md`), so
   * embedding non-active memories is wasted work and would
   * widen the audit-log invariants in ways the doctor checks
   * don't currently bound. The bulk driver
   * {@link reembedAll} respects the same restriction.
   *
   * Per `docs/architecture/data-model.md`, `lastConfirmedAt`
   * equals `MAX(at)` over events including `reembedded`, so the
   * existing monotonic-bump in {@link runLifecycle} applies
   * here too — an isolated rebuild does refresh decay, which
   * matches the spec's "the model+dim is now current" reading.
   */
  setEmbedding(id: MemoryId, input: EmbeddingInput, ctx: { actor: ActorRef }): Promise<Memory>;
}

/**
 * Input shape for {@link MemoryRepository.setEmbedding}. The repo
 * fills in `createdAt`; the embedder owns `model`, `dimension`,
 * and `vector`.
 */
export interface EmbeddingInput {
  readonly model: string;
  readonly dimension: number;
  readonly vector: readonly number[];
}

/**
 * Patch accepted by {@link MemoryRepository.update}. Only fields
 * permitted by the data-model contract (taxonomy + pinning) are
 * settable; content changes are not part of the union.
 *
 * The schema layer additionally requires at least one field to
 * be present; we re-validate against `MemoryEventSchema` (which
 * embeds the same refine) when emitting the `updated` event.
 */
export interface MemoryUpdatePatch {
  readonly tags?: readonly string[];
  readonly kind?: MemoryKind;
  readonly pinned?: boolean;
  /**
   * Toggle the privacy flag (ADR-0012 §3). The patch must still
   * be non-empty; flipping `sensitive` alone is a valid update.
   */
  readonly sensitive?: boolean;
}

/**
 * Dependencies that a {@link MemoryRepository} can inject. Tests
 * pass deterministic versions; production passes the defaults
 * ({@link ulid}, `Date.now`).
 */
export interface RepositoryDeps {
  /** Returns an ISO-8601 ms-precision UTC string. */
  clock?: () => Timestamp;
  /** Returns a fresh memory id (26-char Crockford ULID). */
  memoryIdFactory?: () => MemoryId;
  /** Returns a fresh event id. Same alphabet as the memory id. */
  eventIdFactory?: () => string;
  /**
   * Optional scrubber configuration. When `undefined` or
   * `enabled: false` (the v1 escape hatch from
   * `docs/architecture/scrubber.md`) writes pass through and the
   * resulting `created`/`superseded` event records `scrubReport:
   * null`. When configured and enabled, every write runs the rules
   * before insertion in the same transaction; the report is
   * attached to the corresponding `created` event regardless of
   * whether any rule matched, so audit consumers can distinguish
   * "scrubber ran and was a no-op" from "scrubber did not run".
   */
  scrubber?: { rules: ScrubberRuleSet; enabled?: boolean };
}

const DEFAULT_LIMIT = CONFIG_KEYS['memory.list.defaultLimit'].default;
const MAX_LIMIT = CONFIG_KEYS['memory.list.maxLimit'].default;

export function createMemoryRepository(
  db: Kysely<MementoSchema>,
  deps: RepositoryDeps = {},
): MemoryRepository {
  const clock = deps.clock ?? defaultClock;
  const memoryIdFactory = deps.memoryIdFactory ?? (() => ulid() as unknown as MemoryId);
  const eventIdFactory = deps.eventIdFactory ?? (() => ulid());
  const scrubberActive = deps.scrubber !== undefined && deps.scrubber.enabled !== false;
  const scrubberRules = deps.scrubber?.rules;

  function scrub(content: string): {
    content: string;
    report: ScrubReport | null;
  } {
    if (!scrubberActive || scrubberRules === undefined) {
      return { content, report: null };
    }
    const { scrubbed, report } = applyRules(content, scrubberRules);
    return { content: scrubbed, report };
  }

  return {
    async write(input, ctx) {
      // Idempotency short-circuit (ADR-0012 §2). If the caller
      // supplied a `clientToken`, look for an active memory in
      // the same scope with that token *before* generating an id
      // or running the scrubber. A hit returns the existing
      // memory verbatim — no insert, no audit event. The unique
      // partial index on (scope_json, client_token) where
      // status='active' guarantees at most one match.
      if (input.clientToken !== undefined) {
        const existing = await db
          .selectFrom('memories')
          .selectAll()
          .where('scope_json', '=', JSON.stringify(input.scope))
          .where('client_token', '=', input.clientToken)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (existing !== undefined) {
          return rowToMemory(existing);
        }
      }

      const id = memoryIdFactory();
      const now = clock();
      const tags = normaliseTags(input.tags);
      const scrubbed = scrub(input.content);

      // Build the candidate Memory and parse it. This validates
      // every cross-field invariant (status/supersededBy pairing,
      // lastConfirmedAt >= createdAt, embedding shape, ...) before
      // we ever touch the database.
      const candidate = MemorySchema.parse({
        id,
        createdAt: now,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        scope: input.scope,
        owner: input.owner,
        kind: input.kind,
        tags,
        pinned: input.pinned,
        content: scrubbed.content,
        summary: input.summary,
        status: 'active' as const,
        storedConfidence: input.storedConfidence,
        lastConfirmedAt: now,
        supersedes: null,
        supersededBy: null,
        embedding: null,
        sensitive: input.sensitive ?? false,
      });

      const event = MemoryEventSchema.parse({
        id: eventIdFactory(),
        memoryId: candidate.id,
        at: now,
        actor: ctx.actor,
        scrubReport: scrubbed.report,
        type: 'created',
        payload: {},
      });

      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('memories')
          .values({
            ...memoryToRow(candidate),
            client_token: input.clientToken ?? null,
          })
          .execute();
        await trx.insertInto('memory_events').values(eventToRow(event)).execute();
      });

      return candidate;
    },

    async writeMany(inputs, ctx) {
      // Empty batch: nothing to do, no transaction opened. The
      // command-layer schema rejects this on the wire (min: 1),
      // but the repo stays defensive so downstream callers
      // (programmatic users, tests) don't have to.
      if (inputs.length === 0) {
        return [];
      }

      // Build every candidate Memory + event up-front, *outside*
      // the transaction. Schema parse failures, scrubber
      // explosions, and tag normalisation issues all surface
      // before we hold the writer lock — keeping the contended
      // critical section as small as possible (cf. the WAL
      // concurrency story).
      const prepared = inputs.map((input) => {
        const id = memoryIdFactory();
        const now = clock();
        const tags = normaliseTags(input.tags);
        const scrubbed = scrub(input.content);
        const candidate = MemorySchema.parse({
          id,
          createdAt: now,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          scope: input.scope,
          owner: input.owner,
          kind: input.kind,
          tags,
          pinned: input.pinned,
          content: scrubbed.content,
          summary: input.summary,
          status: 'active' as const,
          storedConfidence: input.storedConfidence,
          lastConfirmedAt: now,
          supersedes: null,
          supersededBy: null,
          embedding: null,
          sensitive: input.sensitive ?? false,
        });
        const event = MemoryEventSchema.parse({
          id: eventIdFactory(),
          memoryId: candidate.id,
          at: now,
          actor: ctx.actor,
          scrubReport: scrubbed.report,
          type: 'created',
          payload: {},
        });
        return { input, candidate, event };
      });

      return await db.transaction().execute(async (trx) => {
        const results: { memory: Memory; idempotent: boolean }[] = [];
        for (const { input, candidate, event } of prepared) {
          // Per-item idempotency check (ADR-0012 §2). The
          // SELECT runs against the same `trx` so an earlier
          // item in the same batch that inserts `(scope,
          // token)` is visible to a later item carrying the
          // same token — the second one is classified as
          // idempotent rather than colliding with the unique
          // partial index.
          if (input.clientToken !== undefined) {
            const existing = await trx
              .selectFrom('memories')
              .selectAll()
              .where('scope_json', '=', JSON.stringify(input.scope))
              .where('client_token', '=', input.clientToken)
              .where('status', '=', 'active')
              .executeTakeFirst();
            if (existing !== undefined) {
              results.push({ memory: rowToMemory(existing), idempotent: true });
              continue;
            }
          }
          await trx
            .insertInto('memories')
            .values({
              ...memoryToRow(candidate),
              client_token: input.clientToken ?? null,
            })
            .execute();
          await trx.insertInto('memory_events').values(eventToRow(event)).execute();
          results.push({ memory: candidate, idempotent: false });
        }
        return results;
      });
    },

    async read(id) {
      const row = await db
        .selectFrom('memories')
        .selectAll()
        .where('id', '=', id as unknown as string)
        .executeTakeFirst();
      return row ? rowToMemory(row) : null;
    },

    async readMany(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db
        .selectFrom('memories')
        .selectAll()
        .where(
          'id',
          'in',
          ids.map((id) => id as unknown as string),
        )
        .execute();
      return rows.map(rowToMemory);
    },

    async list(filter = {}) {
      const limit = clampLimit(filter.limit);
      let query = db
        .selectFrom('memories')
        .selectAll()
        .orderBy('last_confirmed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit);
      if (filter.status !== undefined) {
        query = query.where('status', '=', filter.status);
      }
      if (filter.kind !== undefined) {
        query = query.where('kind_type', '=', filter.kind);
      }
      if (filter.pinned !== undefined) {
        query = query.where('pinned', '=', filter.pinned ? 1 : 0);
      }
      if (filter.createdAtGte !== undefined) {
        query = query.where('created_at', '>=', filter.createdAtGte as unknown as string);
      }
      if (filter.createdAtLte !== undefined) {
        query = query.where('created_at', '<=', filter.createdAtLte as unknown as string);
      }
      if (filter.scope !== undefined) {
        const scopes = Array.isArray(filter.scope)
          ? (filter.scope as readonly Scope[])
          : [filter.scope as Scope];
        if (scopes.length === 0) {
          // An empty list matches no rows. Short-circuit instead
          // of emitting `WHERE FALSE`-style SQL.
          return [];
        }
        query = query.where((eb) =>
          eb.or(
            scopes.map((scope) =>
              eb.and([
                eb('scope_type', '=', scope.type),
                eb('scope_json', '=', JSON.stringify(scope)),
              ]),
            ),
          ),
        );
      }
      const rows = await query.execute();
      return rows.map(rowToMemory);
    },

    async listIdsForBulk(filter) {
      // Mirror the `list` filter logic but project `id` only and
      // skip the `memory.list.maxLimit` clamp. The bulk-destructive
      // command needs the *true* matched count to compare against
      // `safety.bulkDestructiveLimit`; clamping here would silently
      // hide overshoot from the user.
      let query = db
        .selectFrom('memories')
        .select('id')
        .orderBy('last_confirmed_at', 'desc')
        .orderBy('id', 'desc');
      if (filter.status !== undefined) {
        query = query.where('status', '=', filter.status);
      }
      if (filter.kind !== undefined) {
        query = query.where('kind_type', '=', filter.kind);
      }
      if (filter.pinned !== undefined) {
        query = query.where('pinned', '=', filter.pinned ? 1 : 0);
      }
      if (filter.createdAtGte !== undefined) {
        query = query.where('created_at', '>=', filter.createdAtGte as unknown as string);
      }
      if (filter.createdAtLte !== undefined) {
        query = query.where('created_at', '<=', filter.createdAtLte as unknown as string);
      }
      if (filter.scope !== undefined) {
        const scopes = Array.isArray(filter.scope)
          ? (filter.scope as readonly Scope[])
          : [filter.scope as Scope];
        if (scopes.length === 0) {
          return [];
        }
        query = query.where((eb) =>
          eb.or(
            scopes.map((scope) =>
              eb.and([
                eb('scope_type', '=', scope.type),
                eb('scope_json', '=', JSON.stringify(scope)),
              ]),
            ),
          ),
        );
      }
      const rows = await query.execute();
      return rows.map((r) => r.id as MemoryId);
    },

    async supersede(oldId, newInput, ctx) {
      const newId = memoryIdFactory();
      const now = clock();
      const tags = normaliseTags(newInput.tags);
      const scrubbed = scrub(newInput.content);

      const candidate = MemorySchema.parse({
        id: newId,
        createdAt: now,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        scope: newInput.scope,
        owner: newInput.owner,
        kind: newInput.kind,
        tags,
        pinned: newInput.pinned,
        content: scrubbed.content,
        summary: newInput.summary,
        status: 'active' as const,
        storedConfidence: newInput.storedConfidence,
        lastConfirmedAt: now,
        supersedes: oldId,
        supersededBy: null,
        embedding: null,
        sensitive: newInput.sensitive ?? false,
      });

      const createdEvent = MemoryEventSchema.parse({
        id: eventIdFactory(),
        memoryId: candidate.id,
        at: now,
        actor: ctx.actor,
        scrubReport: scrubbed.report,
        type: 'created',
        payload: {},
      });
      const supersededEvent = MemoryEventSchema.parse({
        id: eventIdFactory(),
        memoryId: oldId,
        at: now,
        actor: ctx.actor,
        scrubReport: null,
        type: 'superseded',
        payload: { replacementId: newId },
      });

      return await db.transaction().execute(async (trx) => {
        // Verify the old memory exists and is the current head
        // before inserting anything. Doing this up-front gives a
        // clear error for "not found" / "not active" instead of
        // letting the FK on `supersedes -> oldId` raise an opaque
        // 'FOREIGN KEY constraint failed' for a missing id.
        const oldRow = await trx
          .selectFrom('memories')
          .select(['status', 'superseded_by'])
          .where('id', '=', oldId as unknown as string)
          .executeTakeFirst();
        if (oldRow === undefined) {
          throw new Error(`supersede: memory not found: ${String(oldId)}`);
        }
        if (oldRow.status !== 'active' || oldRow.superseded_by !== null) {
          throw new Error(
            `supersede: memory ${String(oldId)} is not active (status=${oldRow.status})`,
          );
        }

        // Insert the new memory first. SQLite enforces FK constraints
        // immediately (no DEFERRABLE), so the UPDATE that sets
        // `superseded_by = newId` requires the new row to exist.
        await trx.insertInto('memories').values(memoryToRow(candidate)).execute();

        // Conditional update — within a single SQLite transaction the
        // existence check above is sufficient (the writer holds the
        // lock), but the WHERE clause keeps the invariant explicit
        // and survives any future change to the execution model.
        const updateResult = await trx
          .updateTable('memories')
          .set({
            status: 'superseded',
            superseded_by: newId as unknown as string,
          })
          .where('id', '=', oldId as unknown as string)
          .where('status', '=', 'active')
          .where('superseded_by', 'is', null)
          .executeTakeFirst();
        if (updateResult.numUpdatedRows !== 1n) {
          throw new Error(`supersede: race detected on ${String(oldId)}`);
        }

        await trx.insertInto('memory_events').values(eventToRow(createdEvent)).execute();
        await trx.insertInto('memory_events').values(eventToRow(supersededEvent)).execute();

        const previousRow = await trx
          .selectFrom('memories')
          .selectAll()
          .where('id', '=', oldId as unknown as string)
          .executeTakeFirstOrThrow();
        return { previous: rowToMemory(previousRow), current: candidate };
      });
    },

    async confirm(id, ctx) {
      const now = clock();
      return runLifecycle({
        id,
        now,
        actor: ctx.actor,
        eventId: eventIdFactory(),
        // confirm: requires active. No status change. The shared
        // helper bumps `last_confirmed_at = MAX(existing, now)`
        // for every op, so confirm has no extra columns to set.
        op: 'confirm',
        allowedStatuses: ['active'],
        eventType: 'confirmed',
        payload: {},
        update: () => ({}),
      });
    },

    async update(id, patch, ctx) {
      assertNonEmptyPatch(patch);
      const now = clock();
      const updateRow: Partial<MemoriesTable> = {};
      const eventPayload: {
        tags?: string[];
        kind?: MemoryKind;
        pinned?: boolean;
        sensitive?: boolean;
      } = {};
      if (patch.tags !== undefined) {
        const tags = normaliseTags(patch.tags);
        updateRow.tags_json = JSON.stringify(tags);
        eventPayload.tags = tags;
      }
      if (patch.kind !== undefined) {
        updateRow.kind_type = patch.kind.type;
        updateRow.kind_json = JSON.stringify(patch.kind);
        eventPayload.kind = patch.kind;
      }
      if (patch.pinned !== undefined) {
        updateRow.pinned = patch.pinned ? 1 : 0;
        eventPayload.pinned = patch.pinned;
      }
      if (patch.sensitive !== undefined) {
        updateRow.sensitive = patch.sensitive ? 1 : 0;
        eventPayload.sensitive = patch.sensitive;
      }
      return runLifecycle({
        id,
        now,
        actor: ctx.actor,
        eventId: eventIdFactory(),
        op: 'update',
        allowedStatuses: ['active'],
        eventType: 'updated',
        payload: eventPayload,
        update: () => updateRow,
      });
    },

    async forget(id, reason, ctx) {
      const now = clock();
      return runLifecycle({
        id,
        now,
        actor: ctx.actor,
        eventId: eventIdFactory(),
        op: 'forget',
        allowedStatuses: ['active'],
        eventType: 'forgotten',
        payload: { reason },
        update: () => ({ status: 'forgotten' as const }),
      });
    },

    async restore(id, ctx) {
      const now = clock();
      return runLifecycle({
        id,
        now,
        actor: ctx.actor,
        eventId: eventIdFactory(),
        op: 'restore',
        // Both `forgotten` and `archived` are reversible sinks
        // (ADR-0013 §scope and the `MemoryRepository.restore`
        // contract above).
        allowedStatuses: ['forgotten', 'archived'],
        eventType: 'restored',
        payload: {},
        update: () => ({ status: 'active' as const }),
      });
    },

    async archive(id, ctx) {
      const now = clock();
      // Idempotent: if already archived, return the current row
      // unchanged — no event, no update. This lets schedulers run
      // "archive everything in this scope" passes safely.
      const existing = await db
        .selectFrom('memories')
        .selectAll()
        .where('id', '=', id as unknown as string)
        .executeTakeFirst();
      if (existing === undefined) {
        throw new Error(`archive: memory not found: ${String(id)}`);
      }
      if (existing.status === 'archived') {
        return rowToMemory(existing);
      }
      return runLifecycle({
        id,
        now,
        actor: ctx.actor,
        eventId: eventIdFactory(),
        op: 'archive',
        allowedStatuses: ['active', 'forgotten', 'superseded'],
        eventType: 'archived',
        payload: {},
        update: () => ({ status: 'archived' as const }),
      });
    },
    async setEmbedding(id, input, ctx) {
      const now = clock();
      // Build + validate the full Embedding row up front. The
      // schema's `vector.length === dimension` refine surfaces
      // dimension-mismatch errors before we open a transaction,
      // so a misconfigured provider can never half-write.
      const embedding: Embedding = EmbeddingSchema.parse({
        model: input.model,
        dimension: input.dimension,
        vector: input.vector,
        createdAt: now,
      });
      return runLifecycle({
        id,
        now,
        actor: ctx.actor,
        eventId: eventIdFactory(),
        op: 'setEmbedding',
        // Active-only by design (see interface doc-string and
        // retrieval.md). Reembedding a forgotten / archived
        // memory has no consumer in v1.
        allowedStatuses: ['active'],
        eventType: 'reembedded',
        payload: { model: embedding.model, dimension: embedding.dimension },
        update: () => ({ embedding_json: JSON.stringify(embedding) }),
      });
    },
  };

  /**
   * Shared core for the lifecycle transitions. Loads the row,
   * checks the current status against the per-op allowlist,
   * applies the update, appends the corresponding event, and
   * returns the freshly-parsed Memory. All in one transaction.
   */
  async function runLifecycle(args: {
    id: MemoryId;
    now: Timestamp;
    actor: ActorRef;
    eventId: string;
    op: string;
    allowedStatuses: readonly Memory['status'][];
    eventType: MemoryEvent['type'];
    payload: unknown;
    update: () => Partial<MemoriesTable>;
  }): Promise<Memory> {
    return await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('memories')
        .selectAll()
        .where('id', '=', args.id as unknown as string)
        .executeTakeFirst();
      if (row === undefined) {
        throw new Error(`${args.op}: memory not found: ${String(args.id)}`);
      }
      if (!args.allowedStatuses.includes(row.status)) {
        throw new Error(
          `${args.op}: memory ${String(args.id)} status=${row.status} not in [${args.allowedStatuses.join(',')}]`,
        );
      }

      const event = MemoryEventSchema.parse({
        id: args.eventId,
        memoryId: args.id,
        at: args.now,
        actor: args.actor,
        scrubReport: null,
        type: args.eventType,
        payload: args.payload,
      });

      const updates = args.update();
      // Every lifecycle event also bumps last_confirmed_at — the
      // doc-string of MemorySchema describes it as a denormalised
      // cache of MAX(MemoryEvent.at). We take the max of the
      // existing value and `now` so a clock that briefly skews
      // backwards (NTP step, mocked test clock, dev machine
      // resume-from-sleep) cannot regress the cache below the
      // already-recorded MAX(events.at), which would make the
      // invariant `lastConfirmedAt = MAX(events.at)` false and
      // trip `memento doctor`.
      const nowStr = args.now as unknown as string;
      updates.last_confirmed_at = nowStr >= row.last_confirmed_at ? nowStr : row.last_confirmed_at;

      await trx
        .updateTable('memories')
        .set(updates)
        .where('id', '=', args.id as unknown as string)
        .execute();
      await trx.insertInto('memory_events').values(eventToRow(event)).execute();

      const updatedRow = await trx
        .selectFrom('memories')
        .selectAll()
        .where('id', '=', args.id as unknown as string)
        .executeTakeFirstOrThrow();
      return rowToMemory(updatedRow);
    });
  }
}

// — Internals —

function defaultClock(): Timestamp {
  return new Date().toISOString() as unknown as Timestamp;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new RangeError('limit must be a positive integer');
  }
  return Math.min(raw, MAX_LIMIT);
}

function assertNonEmptyPatch(patch: MemoryUpdatePatch): void {
  if (
    patch.tags === undefined &&
    patch.kind === undefined &&
    patch.pinned === undefined &&
    patch.sensitive === undefined
  ) {
    throw new Error('update: patch must change at least one field');
  }
}

/**
 * Tags arrive as `readonly string[]`; normalise through
 * `TagSchema` (trim + lowercase + char-set check) and dedupe.
 * Sorting gives a deterministic on-disk representation that lets
 * a future "tags equal?" check be a string comparison.
 */
function normaliseTags(tags: readonly string[]): Tag[] {
  const seen = new Set<string>();
  const out: Tag[] = [];
  for (const raw of tags) {
    const tag = TagSchema.parse(raw);
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  out.sort();
  return out;
}

function memoryToRow(memory: Memory): MemoriesTable {
  return {
    id: memory.id as unknown as string,
    created_at: memory.createdAt as unknown as string,
    schema_version: memory.schemaVersion,
    scope_type: memory.scope.type,
    scope_json: JSON.stringify(memory.scope),
    owner_type: memory.owner.type,
    owner_id: memory.owner.id,
    kind_type: memory.kind.type,
    kind_json: JSON.stringify(memory.kind),
    tags_json: JSON.stringify(memory.tags),
    pinned: memory.pinned ? 1 : 0,
    content: memory.content,
    summary: memory.summary,
    status: memory.status,
    stored_confidence: memory.storedConfidence,
    last_confirmed_at: memory.lastConfirmedAt as unknown as string,
    supersedes: memory.supersedes as unknown as string | null,
    superseded_by: memory.supersededBy as unknown as string | null,
    embedding_json: memory.embedding === null ? null : JSON.stringify(memory.embedding),
    // `client_token` is not part of `MemorySchema` (ADR-0012 §2 —
    // it's a write-side idempotency primitive, not an entity
    // attribute). Default to NULL here; `write` overrides this
    // via spread when the caller supplies a token.
    client_token: null,
    sensitive: memory.sensitive ? 1 : 0,
  };
}

function eventToRow(event: MemoryEvent): MemoryEventsTable {
  return {
    id: event.id as unknown as string,
    memory_id: event.memoryId as unknown as string,
    at: event.at as unknown as string,
    actor_type: event.actor.type,
    actor_json: JSON.stringify(event.actor),
    type: event.type,
    payload_json: JSON.stringify(event.payload),
    scrub_report_json: event.scrubReport === null ? null : JSON.stringify(event.scrubReport),
  };
}

/**
 * Reverse of {@link memoryToRow}. The returned value passes through
 * `MemorySchema.parse` so any drift between the on-disk row and
 * the schema (e.g. a column populated by a future migration but
 * not yet in the type) is loud rather than silent.
 */
function rowToMemory(row: MemoriesTable): Memory {
  return MemorySchema.parse({
    id: row.id,
    createdAt: row.created_at,
    schemaVersion: row.schema_version,
    scope: JSON.parse(row.scope_json),
    owner: { type: row.owner_type, id: row.owner_id },
    kind: JSON.parse(row.kind_json),
    tags: JSON.parse(row.tags_json),
    pinned: row.pinned === 1,
    content: row.content,
    summary: row.summary,
    status: row.status,
    storedConfidence: row.stored_confidence,
    lastConfirmedAt: row.last_confirmed_at,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    embedding: row.embedding_json === null ? null : JSON.parse(row.embedding_json),
    sensitive: row.sensitive === 1,
  });
}
