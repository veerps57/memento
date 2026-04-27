// Initial schema migration: memories + memory_events + FTS5 index.
//
// Mapping rationale (see docs/architecture/data-model.md):
//
// - Identity, scope, and kind values that carry sub-fields are
//   persisted as both a discriminator column (for cheap filtering /
//   indexing) and a JSON blob (for round-tripping the full Zod
//   value at the repository boundary). Discriminator alone cannot
//   reconstruct the value (e.g. `branch` carries remote+branch);
//   JSON alone is opaque to the query planner. Both is cheap.
// - Booleans are TEXT-free integers (`pinned`, with a CHECK).
// - Timestamps are ISO-8601 TEXT with an explicit lexicographic
//   ordering invariant. ULIDs likewise.
// - `memories.last_confirmed_at` is a denormalised cache of
//   MAX(memory_events.at); the data-model doc spells out who is
//   responsible for keeping it in sync. The column has a CHECK
//   that forbids `last_confirmed_at < created_at`.
//
// FTS5:
//
// We use a contentless FTS5 table (`content=''`) populated by
// AFTER-INSERT/UPDATE/DELETE triggers on `memories`. The triggers
// keep the `rowid` aligned with the integer hash of `id` is *not*
// used; instead each row is referenced by its monotonically
// assigned `rowid`, and a side table maps `rowid <-> memory_id`
// for cheap join-back. Contentless mode avoids storing the prose
// twice and lets us tokenise summary+content together.
//
// Why an explicit mapping table rather than `content='memories'`
// external content: external content requires a stable INTEGER
// rowid in `memories`, which would force us to add an INTEGER
// surrogate key. The mapping table is two columns and a unique
// index — simpler than reshaping the parent table.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0001InitialSchema: Migration = {
  name: '0001_initial_schema',
  async up(db) {
    // memories
    await sql`
      create table memories (
        id                  text    primary key,
        created_at          text    not null,
        schema_version      integer not null,
        scope_type          text    not null check (
          scope_type in ('global','workspace','repo','branch','session')
        ),
        scope_json          text    not null,
        owner_type          text    not null check (
          owner_type in ('local','team','agent')
        ),
        owner_id            text    not null,
        kind_type           text    not null check (
          kind_type in ('fact','preference','decision','todo','snippet')
        ),
        kind_json           text    not null,
        tags_json           text    not null,
        pinned              integer not null check (pinned in (0,1)),
        content             text    not null,
        summary             text,
        status              text    not null check (
          status in ('active','superseded','forgotten','archived')
        ),
        stored_confidence   real    not null check (
          stored_confidence between 0 and 1
        ),
        last_confirmed_at   text    not null check (
          last_confirmed_at >= created_at
        ),
        supersedes          text    references memories(id),
        superseded_by       text    references memories(id),
        embedding_json      text
      ) strict
    `.execute(db);

    // Read indexes. The composite (scope_type, status,
    // last_confirmed_at) covers the dominant retrieval predicate:
    // "active memories in this scope, most-recently-confirmed first".
    await sql`
      create index memories_scope_status_lca
        on memories (scope_type, status, last_confirmed_at desc)
    `.execute(db);
    await sql`
      create index memories_status
        on memories (status)
    `.execute(db);
    await sql`
      create index memories_supersedes
        on memories (supersedes) where supersedes is not null
    `.execute(db);
    await sql`
      create index memories_superseded_by
        on memories (superseded_by) where superseded_by is not null
    `.execute(db);
    await sql`
      create index memories_owner
        on memories (owner_type, owner_id)
    `.execute(db);

    // memory_events
    await sql`
      create table memory_events (
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
            'forgotten','restored','archived','reembedded'
          )
        ),
        payload_json       text    not null,
        scrub_report_json  text
      ) strict
    `.execute(db);
    // (memory_id, at) covers "latest event per memory" and history
    // listing. ULIDs in `id` are already lexicographically sortable
    // by time, so a separate global-history index is redundant.
    await sql`
      create index memory_events_memory_at
        on memory_events (memory_id, at)
    `.execute(db);
    await sql`
      create index memory_events_type_at
        on memory_events (type, at)
    `.execute(db);

    // FTS5 + rowid mapping. Contentless: prose is stored once in
    // `memories.content`/`summary`. The mapping table joins back
    // to the canonical id.
    await sql`
      create virtual table memories_fts using fts5(
        content,
        summary,
        content=''
      )
    `.execute(db);
    await sql`
      create table memories_fts_map (
        rowid     integer primary key,
        memory_id text    not null unique references memories(id)
      ) strict
    `.execute(db);

    // Triggers keep the FTS index in lockstep with `memories`.
    // Insert: assign a fresh rowid (let SQLite pick), record the
    // mapping, then write the FTS row using that rowid.
    await sql`
      create trigger memories_ai_fts after insert on memories begin
        insert into memories_fts_map (memory_id) values (new.id);
        insert into memories_fts (rowid, content, summary)
          values (
            (select rowid from memories_fts_map where memory_id = new.id),
            new.content,
            coalesce(new.summary, '')
          );
      end
    `.execute(db);
    // Update: delete-then-insert against the same rowid to refresh
    // the FTS row. This is the FTS5-recommended pattern for
    // contentless tables (no shadow content to update in place).
    await sql`
      create trigger memories_au_fts after update of content, summary on memories begin
        insert into memories_fts (memories_fts, rowid, content, summary)
          values (
            'delete',
            (select rowid from memories_fts_map where memory_id = old.id),
            old.content,
            coalesce(old.summary, '')
          );
        insert into memories_fts (rowid, content, summary)
          values (
            (select rowid from memories_fts_map where memory_id = new.id),
            new.content,
            coalesce(new.summary, '')
          );
      end
    `.execute(db);
    // Delete: in v1 we never hard-delete a memory (status flips
    // instead), but the trigger guards against future repository
    // changes and against `memento doctor --fix` rebuilding rows.
    //
    // BEFORE-delete (rather than AFTER) is intentional: the FTS
    // `delete` directive needs the rowid mapping to still be live,
    // and we need to drop the mapping row before the parent row
    // disappears so the foreign-key check on the mapping table
    // does not fail at statement end.
    await sql`
      create trigger memories_bd_fts before delete on memories begin
        insert into memories_fts (memories_fts, rowid, content, summary)
          values (
            'delete',
            (select rowid from memories_fts_map where memory_id = old.id),
            old.content,
            coalesce(old.summary, '')
          );
        delete from memories_fts_map where memory_id = old.id;
      end
    `.execute(db);
  },
};
