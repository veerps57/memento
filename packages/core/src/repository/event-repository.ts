/**
 * Read-only access to `memory_events`.
 *
 * Writes happen as side-effects of {@link MemoryRepository}
 * methods — the audit log is append-only and there is no public
 * surface for inserting an event in isolation. This module
 * exists so consumers (decay jobs, audit UIs, the eventual MCP
 * server) can *query* the log without reaching for raw SQL.
 *
 * All rows are parsed back through `MemoryEventSchema` on the
 * way out so any drift between storage and the schema raises an
 * exception at the boundary rather than producing silently-
 * malformed events.
 */

import {
  CONFIG_KEYS,
  type EventId,
  type MemoryEvent,
  MemoryEventSchema,
  type MemoryId,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import type { MementoSchema, MemoryEventsTable } from '../storage/schema.js';

const DEFAULT_LIMIT = CONFIG_KEYS['events.list.defaultLimit'].default;
const MAX_LIMIT = CONFIG_KEYS['events.list.maxLimit'].default;

export interface EventListFilter {
  /** Restrict to events of these types. */
  readonly types?: readonly MemoryEvent['type'][];
  /** Maximum rows to return; defaults to {@link DEFAULT_LIMIT}, capped at {@link MAX_LIMIT}. */
  readonly limit?: number;
}

export interface EventRepository {
  /**
   * Single event by id, or `null` if no row matches. Useful for
   * UIs that link to a specific entry in the audit log
   * (`memory.events` returns ids that callers may want to fetch
   * back individually) and for follow-up actions that operate on
   * a known event (e.g. retrying a failed conflict scan).
   */
  read(id: EventId): Promise<MemoryEvent | null>;
  /**
   * All events for one memory in commit order (ascending event id —
   * ULIDs sort lexicographically by time-of-creation, so this is a
   * stable wall-clock-ish ordering).
   */
  listForMemory(id: MemoryId, filter?: EventListFilter): Promise<MemoryEvent[]>;
  /**
   * Cross-memory tail of the audit log, newest-first. Useful for
   * reviewers and dashboards.
   */
  listRecent(filter?: EventListFilter): Promise<MemoryEvent[]>;
  /**
   * The most recent event for a memory, or `null` if none. Equivalent
   * to `listForMemory(id, { limit: 1 })` reversed; provided as a
   * named method because callers want the "what changed last?"
   * answer often enough that the indirection adds noise.
   */
  latestForMemory(id: MemoryId): Promise<MemoryEvent | null>;
  /**
   * Total number of events for a memory. O(log n) on the
   * `idx_memory_events_memory` index from migration 0001.
   */
  countForMemory(id: MemoryId): Promise<number>;
}

export function createEventRepository(db: Kysely<MementoSchema>): EventRepository {
  return {
    async read(id) {
      const row = await db
        .selectFrom('memory_events')
        .selectAll()
        .where('id', '=', id as unknown as string)
        .executeTakeFirst();
      return row === undefined ? null : rowToEvent(row);
    },

    async listForMemory(id, filter) {
      let query = db
        .selectFrom('memory_events')
        .selectAll()
        .where('memory_id', '=', id as unknown as string)
        .orderBy('id', 'asc')
        .limit(clampLimit(filter?.limit));
      if (filter?.types && filter.types.length > 0) {
        query = query.where('type', 'in', filter.types);
      }
      const rows = await query.execute();
      return rows.map(rowToEvent);
    },

    async listRecent(filter) {
      let query = db
        .selectFrom('memory_events')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(clampLimit(filter?.limit));
      if (filter?.types && filter.types.length > 0) {
        query = query.where('type', 'in', filter.types);
      }
      const rows = await query.execute();
      return rows.map(rowToEvent);
    },

    async latestForMemory(id) {
      const row = await db
        .selectFrom('memory_events')
        .selectAll()
        .where('memory_id', '=', id as unknown as string)
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : rowToEvent(row);
    },

    async countForMemory(id) {
      const row = await db
        .selectFrom('memory_events')
        .select(({ fn }) => [fn.countAll<number>().as('n')])
        .where('memory_id', '=', id as unknown as string)
        .executeTakeFirstOrThrow();
      // better-sqlite3 returns counts as `number` already, but
      // defensively coerce so the surface is `number` even if a
      // future driver upgrade returns bigint.
      return Number(row.n);
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

/**
 * Inverse of `eventToRow` in {@link ./memory-repository.ts}.
 * Reconstructs the discriminated union by passing the raw payload
 * through `MemoryEventSchema.parse`, which selects the right
 * branch based on `type`.
 */
function rowToEvent(row: MemoryEventsTable): MemoryEvent {
  return MemoryEventSchema.parse({
    id: row.id,
    memoryId: row.memory_id,
    at: row.at,
    actor: JSON.parse(row.actor_json),
    scrubReport: row.scrub_report_json === null ? null : JSON.parse(row.scrub_report_json),
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });
}
