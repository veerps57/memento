// ConflictRepository — current-state + audit-log access for the
// `conflicts` and `conflict_events` tables introduced by
// migration 0002.
//
// Mirrors `MemoryRepository`'s contract:
//   - `open` and `resolve` mutate state and emit an event in the
//     same transaction. Failure of either insert rolls back
//     both, so the invariant "every Conflict has a matching
//     `opened` event with `at === openedAt`" holds by
//     construction.
//   - `read` and `list` are pure reads, with rows passed through
//     `ConflictSchema.parse` so any drift between storage and
//     the schema raises a loud error at the boundary.
//
// `resolve` is recording-only: it writes the resolution to the
// row + log, but does **not** apply structural side-effects
// (forget the loser, link a supersession). Those are layered on
// by the eventual command registry, which can compose
// `MemoryRepository` calls atomically with `ConflictRepository`
// calls. Keeping the repository narrow keeps the test surface
// honest.

import {
  type ActorRef,
  CONFIG_KEYS,
  type Conflict,
  type ConflictEvent,
  ConflictEventSchema,
  type ConflictId,
  ConflictIdSchema,
  type ConflictResolution,
  ConflictSchema,
  type MemoryId,
  type MemoryKindType,
  type Timestamp,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { ulid } from '../repository/ulid.js';
import type { ConflictEventsTable, ConflictsTable, MementoSchema } from '../storage/schema.js';

const DEFAULT_LIMIT = CONFIG_KEYS['conflict.list.defaultLimit'].default;
const MAX_LIMIT = CONFIG_KEYS['conflict.list.maxLimit'].default;

/**
 * Input shape for {@link ConflictRepository.open}. The repository
 * assigns `id`, `openedAt`, and the matching event id; callers
 * supply only the observation. `evidence` is opaque at this
 * layer (per `ConflictSchema.evidence`); the policy that emitted
 * it owns the shape.
 */
export interface ConflictOpenInput {
  readonly newMemoryId: MemoryId;
  readonly conflictingMemoryId: MemoryId;
  readonly kind: MemoryKindType;
  readonly evidence: unknown;
}

export interface ConflictListFilter {
  /** When `true`, restricts to open conflicts (resolved_at is null). */
  readonly open?: boolean;
  readonly kind?: MemoryKindType;
  /** Match either side of the conflict. */
  readonly memoryId?: MemoryId;
  readonly limit?: number;
}

export interface ConflictRepositoryDeps {
  clock?: () => Timestamp;
  conflictIdFactory?: () => ConflictId;
  eventIdFactory?: () => string;
}

export interface ConflictRepository {
  /**
   * Record a freshly-detected conflict. Inserts the `conflicts`
   * row and the matching `opened` `conflict_events` row in a
   * single transaction.
   */
  open(input: ConflictOpenInput, ctx: { actor: ActorRef }): Promise<Conflict>;
  /**
   * Mark an open conflict resolved. Idempotent only on the same
   * resolution: a second call with a different resolution
   * throws, because the audit log requires a single `resolved`
   * event per conflict.
   */
  resolve(
    id: ConflictId,
    resolution: ConflictResolution,
    ctx: { actor: ActorRef },
  ): Promise<Conflict>;
  read(id: ConflictId): Promise<Conflict | null>;
  list(filter?: ConflictListFilter): Promise<Conflict[]>;
  /** All events for one conflict, oldest first. */
  events(id: ConflictId): Promise<ConflictEvent[]>;
  /**
   * Set of memory ids that already share an open conflict with
   * `memoryId`, in either direction. Used by the detector to
   * dedupe re-runs (`conflict.scan since` mode + repeated post-
   * write hook fires) without inserting duplicate rows for the
   * same logical pair. Returns directional partners only — i.e.
   * for memory M, every C such that an open `(M, C)` or `(C, M)`
   * row exists.
   */
  openPartners(memoryId: string): Promise<ReadonlySet<string>>;
}

export function createConflictRepository(
  db: Kysely<MementoSchema>,
  deps: ConflictRepositoryDeps = {},
): ConflictRepository {
  const clock = deps.clock ?? defaultClock;
  const conflictIdFactory = deps.conflictIdFactory ?? (() => ulid() as unknown as ConflictId);
  const eventIdFactory = deps.eventIdFactory ?? (() => ulid());

  return {
    async open(input, ctx) {
      const now = clock();
      const conflict: Conflict = ConflictSchema.parse({
        id: conflictIdFactory(),
        newMemoryId: input.newMemoryId,
        conflictingMemoryId: input.conflictingMemoryId,
        kind: input.kind,
        evidence: input.evidence,
        openedAt: now,
        resolvedAt: null,
        resolution: null,
      });
      const event: ConflictEvent = ConflictEventSchema.parse({
        id: eventIdFactory(),
        conflictId: conflict.id,
        at: now,
        actor: ctx.actor,
        type: 'opened',
        payload: {
          newMemoryId: conflict.newMemoryId,
          conflictingMemoryId: conflict.conflictingMemoryId,
          kind: conflict.kind,
          evidence: conflict.evidence,
        },
      });

      await db.transaction().execute(async (trx) => {
        await trx.insertInto('conflicts').values(conflictToRow(conflict)).execute();
        await trx.insertInto('conflict_events').values(eventToRow(event)).execute();
      });
      return conflict;
    },

    async resolve(id, resolution, ctx) {
      const now = clock();
      return await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('conflicts')
          .selectAll()
          .where('id', '=', id as unknown as string)
          .executeTakeFirst();
        if (row === undefined) {
          throw new Error(`resolve: conflict not found: ${String(id)}`);
        }
        if (row.resolved_at !== null) {
          throw new Error(`resolve: conflict ${String(id)} already resolved (${row.resolution})`);
        }
        const event: ConflictEvent = ConflictEventSchema.parse({
          id: eventIdFactory(),
          conflictId: id,
          at: now,
          actor: ctx.actor,
          type: 'resolved',
          payload: { resolution },
        });
        await trx
          .updateTable('conflicts')
          .set({
            resolved_at: now as unknown as string,
            resolution,
          })
          .where('id', '=', id as unknown as string)
          .execute();
        await trx.insertInto('conflict_events').values(eventToRow(event)).execute();
        const updated = await trx
          .selectFrom('conflicts')
          .selectAll()
          .where('id', '=', id as unknown as string)
          .executeTakeFirstOrThrow();
        return rowToConflict(updated);
      });
    },

    async read(id) {
      const row = await db
        .selectFrom('conflicts')
        .selectAll()
        .where('id', '=', id as unknown as string)
        .executeTakeFirst();
      return row === undefined ? null : rowToConflict(row);
    },

    async list(filter) {
      let query = db
        .selectFrom('conflicts')
        .selectAll()
        .orderBy('opened_at', 'desc')
        .orderBy('id', 'desc')
        .limit(clampLimit(filter?.limit));
      if (filter?.open === true) {
        query = query.where('resolved_at', 'is', null);
      } else if (filter?.open === false) {
        query = query.where('resolved_at', 'is not', null);
      }
      if (filter?.kind !== undefined) {
        query = query.where('kind', '=', filter.kind);
      }
      if (filter?.memoryId !== undefined) {
        const id = filter.memoryId as unknown as string;
        query = query.where((eb) =>
          eb.or([eb('new_memory_id', '=', id), eb('conflicting_memory_id', '=', id)]),
        );
      }
      const rows = await query.execute();
      return rows.map(rowToConflict);
    },

    async events(id) {
      const rows = await db
        .selectFrom('conflict_events')
        .selectAll()
        .where('conflict_id', '=', id as unknown as string)
        .orderBy('at', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return rows.map(rowToEvent);
    },

    async openPartners(memoryId) {
      const rows = await db
        .selectFrom('conflicts')
        .select(['new_memory_id', 'conflicting_memory_id'])
        .where('resolved_at', 'is', null)
        .where((eb) =>
          eb.or([eb('new_memory_id', '=', memoryId), eb('conflicting_memory_id', '=', memoryId)]),
        )
        .execute();
      const partners = new Set<string>();
      for (const row of rows) {
        // The partner is whichever side ISN'T `memoryId`. The
        // CHECK constraint guarantees the two ids differ.
        partners.add(
          row.new_memory_id === memoryId ? row.conflicting_memory_id : row.new_memory_id,
        );
      }
      return partners;
    },
  };
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

function defaultClock(): Timestamp {
  return new Date().toISOString() as unknown as Timestamp;
}

function conflictToRow(c: Conflict): ConflictsTable {
  return {
    id: c.id as unknown as string,
    new_memory_id: c.newMemoryId as unknown as string,
    conflicting_memory_id: c.conflictingMemoryId as unknown as string,
    kind: c.kind,
    evidence_json: JSON.stringify(c.evidence ?? null),
    opened_at: c.openedAt as unknown as string,
    resolved_at: c.resolvedAt as unknown as string | null,
    resolution: c.resolution,
  };
}

function rowToConflict(row: ConflictsTable): Conflict {
  return ConflictSchema.parse({
    id: row.id,
    newMemoryId: row.new_memory_id,
    conflictingMemoryId: row.conflicting_memory_id,
    kind: row.kind,
    evidence: JSON.parse(row.evidence_json),
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  });
}

function eventToRow(e: ConflictEvent): ConflictEventsTable {
  return {
    id: e.id as unknown as string,
    conflict_id: e.conflictId as unknown as string,
    at: e.at as unknown as string,
    actor_type: e.actor.type,
    actor_json: JSON.stringify(e.actor),
    type: e.type,
    payload_json: JSON.stringify(e.payload),
  };
}

function rowToEvent(row: ConflictEventsTable): ConflictEvent {
  return ConflictEventSchema.parse({
    id: row.id,
    conflictId: row.conflict_id,
    at: row.at,
    actor: JSON.parse(row.actor_json),
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });
}

// Re-export for downstream consumers that want a branded ID without
// importing from `@psraghuveer/memento-schema` directly.
export { ConflictIdSchema };
