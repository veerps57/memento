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
  /**
   * Optional engine-effective value at the moment the caller
   * issued the set. When provided AND there is no prior event for
   * this key (i.e. the set runtime layer was empty), it is
   * recorded as the event's `oldValue` instead of `null`. This
   * makes the audit trail meaningful for first-time edits — a
   * dashboard can render "default → newValue" instead of
   * "null → newValue". When omitted, the legacy behaviour
   * (oldValue=null when no prior event) is preserved so existing
   * callers (CLI, MCP, scripts) keep their semantics.
   */
  readonly priorEffectiveValue?: unknown;
}

export interface ConfigUnsetInput {
  readonly key: string;
  readonly source: ConfigSource;
  /** Same semantics as {@link ConfigSetInput.priorEffectiveValue}. */
  readonly priorEffectiveValue?: unknown;
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
        const oldValue = await resolveOldValue(trx, input.key, input.priorEffectiveValue);
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
        const oldValue = await resolveOldValue(trx, input.key, input.priorEffectiveValue);
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
 * key.
 *
 * Distinguishes three states via the returned discriminated
 * shape:
 *
 *   - `{ found: false }` — no prior event for this key
 *     (so the runtime layer is empty; the caller may want to
 *     substitute the engine's effective value as `oldValue`).
 *   - `{ found: true, value: null }` — the latest event was an
 *     `unset`, OR the latest stored value was the JSON literal
 *     `null`. Either way, the prior runtime state was "absent /
 *     null"; the caller should record that faithfully.
 *   - `{ found: true, value: <T> }` — a prior `set` event
 *     persisted that value.
 *
 * The previous helper (`readLatestValueJson`) collapsed the
 * first two cases into `null`, which made it impossible for the
 * audit chain to record "first edit went from default → X" —
 * the dashboard rendered every initial edit as `null → X`.
 */
async function readLatestEventValueJson(
  trx: Kysely<MementoSchema>,
  key: string,
): Promise<{ readonly found: false } | { readonly found: true; readonly value: unknown }> {
  const row = await trx
    .selectFrom('config_events')
    .select('new_value_json')
    .where('key', '=', key)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return { found: false };
  if (row.new_value_json === null) return { found: true, value: null };
  return { found: true, value: JSON.parse(row.new_value_json) };
}

/**
 * Compute the `oldValue` to record on a `set` or `unset` event.
 *
 * The audit chain wants `oldValue` to reflect the engine's
 * **effective** value at the moment of the edit, not just the
 * latest event's `newValue`. There are two cases where the latest
 * event isn't authoritative — both representing "the runtime
 * layer is empty, so the engine has reverted to a lower layer
 * (defaults / startup config)":
 *
 *   1. No event exists for this key yet.
 *   2. The latest event was an `unset` (i.e. its `newValue` is
 *      `null`).
 *
 * In either case the caller-supplied `priorEffectiveValue`
 * (typically `configStore.entry(key).value`) wins. When no
 * `priorEffectiveValue` is supplied we fall back to `null`,
 * preserving the legacy semantics for callers that don't want
 * to plumb the store through (CLI scripts, tests, etc.).
 */
async function resolveOldValue(
  trx: Kysely<MementoSchema>,
  key: string,
  priorEffectiveValue: unknown,
): Promise<unknown> {
  const fromEvent = await readLatestEventValueJson(trx, key);
  const runtimeEmpty = !fromEvent.found || fromEvent.value === null;
  if (runtimeEmpty) {
    return priorEffectiveValue !== undefined ? priorEffectiveValue : null;
  }
  return fromEvent.value;
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
