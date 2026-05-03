// Migration 0006: widen `memory_events.type` CHECK constraint to
// admit `'imported'`.
//
// Background. The append-only audit log gains a new event variant
// to record memories that arrived via `memento import`. The
// importer never trusts caller-supplied audit events: by default
// the entire source event chain is collapsed into a single
// `imported` event whose payload retains the source provenance
// for forensics. See `MEMORY_EVENT_TYPES` in
// `@psraghuveer/memento-schema` for the variant definition and
// the security rationale (importer cannot accept forged actor
// or timestamp claims — direct violation of AGENTS.md rule 11).
//
// SQLite cannot alter a CHECK constraint in place. The standard
// workaround is the canonical "rename + recreate + copy + drop +
// rename" pattern, executed inside the migration transaction the
// runner already provides:
//
//   1. Create `memory_events_new` with the widened CHECK and the
//      same column shape.
//   2. Copy every row from `memory_events` into the new table.
//   3. Drop the old indexes (they reference the table name).
//   4. Drop `memory_events`.
//   5. Rename `memory_events_new` to `memory_events`.
//   6. Recreate the indexes.
//
// No table foreign-keys *into* `memory_events` (verified by grep
// for `references memory_events` across all migrations), so the
// drop-and-rename is safe without toggling `pragma foreign_keys`.
//
// Forward-only. No `down`: dropping support for the `imported`
// variant from a deployment that has already recorded import
// events would corrupt the audit log.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0006MemoryEventsImportedType: Migration = {
  name: '0006_memory_events_imported_type',
  async up(db) {
    // 1. New table with widened CHECK.
    await sql`
      create table memory_events_new (
        id                 text    primary key,
        memory_id          text    not null references memories(id),
        at                 text    not null,
        actor_type         text    not null check (
          actor_type in ('cli','mcp','scheduler','system')
        ),
        actor_json         text    not null,
        type               text    not null check (
          type in (
            'created','confirmed','updated','superseded',
            'forgotten','restored','archived','reembedded',
            'imported'
          )
        ),
        payload_json       text    not null,
        scrub_report_json  text
      ) strict
    `.execute(db);

    // 2. Copy.
    await sql`
      insert into memory_events_new
        (id, memory_id, at, actor_type, actor_json, type, payload_json, scrub_report_json)
      select
        id, memory_id, at, actor_type, actor_json, type, payload_json, scrub_report_json
      from memory_events
    `.execute(db);

    // 3. Drop old indexes.
    await sql`drop index if exists memory_events_memory_at`.execute(db);
    await sql`drop index if exists memory_events_type_at`.execute(db);

    // 4. Drop the old table.
    await sql`drop table memory_events`.execute(db);

    // 5. Rename.
    await sql`alter table memory_events_new rename to memory_events`.execute(db);

    // 6. Recreate indexes (same shape as 0001).
    await sql`
      create index memory_events_memory_at
        on memory_events (memory_id, at)
    `.execute(db);
    await sql`
      create index memory_events_type_at
        on memory_events (type, at)
    `.execute(db);
  },
};
