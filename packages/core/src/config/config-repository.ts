// ConfigRepository — append-only access to the `config_events`
// table introduced in migration 0002.
//
// The repository owns the *audit log*, not the layered runtime
// view. Two reasons for the split:
//
//   1. The runtime view is a snapshot consumed by every
//      `ConfigStore.get(...)` call across the engine. It must
//      not hit SQL on the hot read path. The store loads from
//      the repo once at startup and applies events on
//      `config.set` / `config.unset` thereafter.
//   2. The log is the source of truth for provenance and
//      history (`memento config history --key=...`). Keeping it
//      behind a typed repo with `currentValues` / `history` /
//      `set` / `unset` methods means the rest of the engine
//      never reaches for raw SQL.
//
// `set` and `unset` are tx-atomic: each writes one event, with
// `oldValue` derived inside the same transaction from the
// most-recent prior event. A concurrent set on the same key
// would otherwise read a stale `oldValue` and the audit chain
// would lose a link.
//
// `currentValues` collapses the log: for every key that has at
// least one event, take the newest one. If the newest is an
// `unset` (i.e. `new_value_json IS NULL`) the key is *omitted*
// from the result — `unset` reverts the runtime layer to the
// next-lower one, and the loader expresses that by leaving the
// key absent from the override map.

import {
  type ActorRef,
  type ConfigEvent,
  ConfigEventSchema,
  type ConfigSource,
  type EventId,
  type Timestamp,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { ulid } from '../repository/ulid.js';
import type { ConfigEventsTable, MementoSchema } from '../storage/schema.js';

/**
 * Snapshot entry produced by {@link ConfigRepository.currentValues}.
 * The `setAt` and `setBy` are the wall-clock and actor of the
 * winning event — i.e. the most recent `set` for this key.
 */
export interface ConfigCurrentEntry {
  readonly key: string;
  readonly value: unknown;
  readonly source: ConfigSource;
  readonly setAt: Timestamp;
  readonly setBy: ActorRef;
}

export interface ConfigSetInput {
  readonly key: string;
  /** JSON-serialisable value; the per-key Zod schema is the caller's responsibility. */
  readonly value: unknown;
  readonly source: ConfigSource;
}

export interface ConfigUnsetInput {
  readonly key: string;
  readonly source: ConfigSource;
}

export interface ConfigRepositoryDeps {
  clock?: () => Timestamp;
  eventIdFactory?: () => string;
}

export interface ConfigRepository {
  /**
   * Append a `set` event. Looks up the previous value for the
   * key inside the same transaction so the recorded `oldValue`
   * is always the immediately-prior state.
   */
  set(input: ConfigSetInput, ctx: { actor: ActorRef }): Promise<ConfigEvent>;
  /**
   * Append an `unset` event (`newValue: null`). The same
   * tx-atomic prior-value lookup applies.
   */
  unset(input: ConfigUnsetInput, ctx: { actor: ActorRef }): Promise<ConfigEvent>;
  /**
   * Latest event per key, collapsed to current values. Keys
   * whose latest event is an `unset` are omitted (the runtime
   * layer is empty for them). Map iteration order is insertion
   * order, which has no meaning here — callers should not depend
   * on it.
   */
  currentValues(): Promise<ReadonlyMap<string, ConfigCurrentEntry>>;
  /**
   * All events for one key, oldest-first. `limit` defaults to
   * unbounded; callers that paginate (the planned
   * `config.history`) supply their own.
   */
  history(key: string, limit?: number): Promise<ConfigEvent[]>;
}

const defaultClock = (): Timestamp => new Date().toISOString() as Timestamp;

export function createConfigRepository(
  db: Kysely<MementoSchema>,
  deps: ConfigRepositoryDeps = {},
): ConfigRepository {
  const clock = deps.clock ?? defaultClock;
  const eventIdFactory = deps.eventIdFactory ?? (() => ulid());

  return {
    async set(input, ctx) {
      return await db.transaction().execute(async (trx) => {
        const oldValue = await readLatestValueJson(trx, input.key);
        const event: ConfigEvent = ConfigEventSchema.parse({
          id: eventIdFactory() as EventId,
          key: input.key,
          oldValue,
          newValue: input.value,
          source: input.source,
          actor: ctx.actor,
          at: clock(),
        });
        await trx.insertInto('config_events').values(eventToRow(event)).execute();
        return event;
      });
    },

    async unset(input, ctx) {
      return await db.transaction().execute(async (trx) => {
        const oldValue = await readLatestValueJson(trx, input.key);
        const event: ConfigEvent = ConfigEventSchema.parse({
          id: eventIdFactory() as EventId,
          key: input.key,
          oldValue,
          newValue: null,
          source: input.source,
          actor: ctx.actor,
          at: clock(),
        });
        await trx.insertInto('config_events').values(eventToRow(event)).execute();
        return event;
      });
    },

    async currentValues() {
      // SQLite supports the correlated-subquery form below, and
      // the `(key, at desc)` index makes the scan cheap even
      // when the log gets large.
      const rows = await db
        .selectFrom('config_events as outer')
        .selectAll()
        .where(({ eb, selectFrom }) =>
          eb(
            'outer.id',
            '=',
            selectFrom('config_events as inner_evt')
              .select(({ fn }) => fn.max('inner_evt.id').as('max_id'))
              .whereRef('inner_evt.key', '=', 'outer.key'),
          ),
        )
        .execute();
      const map = new Map<string, ConfigCurrentEntry>();
      for (const row of rows) {
        if (row.new_value_json === null) continue; // latest is unset
        map.set(row.key, {
          key: row.key,
          value: JSON.parse(row.new_value_json),
          source: row.source,
          setAt: row.at as Timestamp,
          setBy: JSON.parse(row.actor_json),
        });
      }
      return map;
    },

    async history(key, limit) {
      let query = db
        .selectFrom('config_events')
        .selectAll()
        .where('key', '=', key)
        .orderBy('id', 'asc');
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new RangeError('limit must be a positive integer');
        }
        query = query.limit(limit);
      }
      const rows = await query.execute();
      return rows.map(rowToEvent);
    },
  };
}

/**
 * Inside a transaction, read the latest persisted value for one
 * key. Returns `null` when there are no prior events, when the
 * latest event was an `unset`, or when the latest stored value
 * was the JSON literal `null` — in all three cases the prior
 * runtime override is "absent", which is the meaning the audit
 * `oldValue` field carries.
 */
async function readLatestValueJson(
  trx: Kysely<MementoSchema>,
  key: string,
): Promise<unknown | null> {
  const row = await trx
    .selectFrom('config_events')
    .select('new_value_json')
    .where('key', '=', key)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return null;
  if (row.new_value_json === null) return null;
  return JSON.parse(row.new_value_json);
}

function eventToRow(event: ConfigEvent): ConfigEventsTable {
  return {
    id: event.id as unknown as string,
    key: event.key,
    old_value_json: event.oldValue === null ? null : JSON.stringify(event.oldValue),
    new_value_json: event.newValue === null ? null : JSON.stringify(event.newValue),
    source: event.source,
    actor_type: event.actor.type,
    actor_json: JSON.stringify(event.actor),
    at: event.at,
  };
}

function rowToEvent(row: ConfigEventsTable): ConfigEvent {
  return ConfigEventSchema.parse({
    id: row.id,
    key: row.key,
    oldValue: row.old_value_json === null ? null : JSON.parse(row.old_value_json),
    newValue: row.new_value_json === null ? null : JSON.parse(row.new_value_json),
    source: row.source,
    actor: JSON.parse(row.actor_json),
    at: row.at,
  });
}
