// Migration 0005: add `tags` column to the FTS5 index.
//
// The original FTS5 table indexes `content` and `summary` only.
// Tag-based discovery is a primary agent workflow ("find all
// memories tagged project:memento") but was impossible via text
// search because tags were never indexed.
//
// FTS5 virtual tables cannot be altered — the only way to add a
// column is to drop and rebuild. This migration:
//
//   1. Drops the existing triggers (they reference the old schema).
//   2. Drops the FTS virtual table (but preserves the mapping
//      table — rowids stay stable).
//   3. Recreates the FTS table with three columns: content,
//      summary, tags.
//   4. Re-populates the FTS rows from `memories` joined through
//      `memories_fts_map` (tags are space-joined from the JSON
//      array so FTS tokenises them individually).
//   5. Recreates triggers to keep the new schema in sync,
//      including firing on `tags_json` updates.
//
// The `tags` column stores a space-separated representation of
// the JSON array (e.g. `["arch","config"]` → `"arch config"`).
// This lets FTS5's tokenizer index each tag as a separate token.
// Colon-namespaced tags like `project:memento` are kept intact
// (the `unicode61` tokenizer treats `:` as a token character
// when it appears between alphanumerics).
//
// Forward-only. No `down`.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0005FtsAddTags: Migration = {
  name: '0005_fts_add_tags',
  async up(db) {
    // 1. Drop existing triggers.
    await sql`drop trigger if exists memories_ai_fts`.execute(db);
    await sql`drop trigger if exists memories_au_fts`.execute(db);
    await sql`drop trigger if exists memories_bd_fts`.execute(db);

    // 2. Drop the old FTS virtual table.
    await sql`drop table if exists memories_fts`.execute(db);

    // 3. Recreate with the `tags` column.
    await sql`
      create virtual table memories_fts using fts5(
        content,
        summary,
        tags,
        content=''
      )
    `.execute(db);

    // 4. Re-populate from existing data. Tags are extracted from
    //    the JSON array and space-joined so each tag becomes a
    //    separate FTS token.
    await sql`
      insert into memories_fts (rowid, content, summary, tags)
        select
          map.rowid,
          m.content,
          coalesce(m.summary, ''),
          coalesce(
            (select group_concat(value, ' ') from json_each(m.tags_json)),
            ''
          )
        from memories_fts_map map
        join memories m on m.id = map.memory_id
    `.execute(db);

    // 5. Recreate triggers with the new column set.
    // Insert trigger.
    await sql`
      create trigger memories_ai_fts after insert on memories begin
        insert into memories_fts_map (memory_id) values (new.id);
        insert into memories_fts (rowid, content, summary, tags)
          values (
            (select rowid from memories_fts_map where memory_id = new.id),
            new.content,
            coalesce(new.summary, ''),
            coalesce(
              (select group_concat(value, ' ') from json_each(new.tags_json)),
              ''
            )
          );
      end
    `.execute(db);

    // Update trigger — fires on content, summary, or tags_json changes.
    await sql`
      create trigger memories_au_fts after update of content, summary, tags_json on memories begin
        insert into memories_fts (memories_fts, rowid, content, summary, tags)
          values (
            'delete',
            (select rowid from memories_fts_map where memory_id = old.id),
            old.content,
            coalesce(old.summary, ''),
            coalesce(
              (select group_concat(value, ' ') from json_each(old.tags_json)),
              ''
            )
          );
        insert into memories_fts (rowid, content, summary, tags)
          values (
            (select rowid from memories_fts_map where memory_id = new.id),
            new.content,
            coalesce(new.summary, ''),
            coalesce(
              (select group_concat(value, ' ') from json_each(new.tags_json)),
              ''
            )
          );
      end
    `.execute(db);

    // Delete trigger (BEFORE, same rationale as 0001).
    await sql`
      create trigger memories_bd_fts before delete on memories begin
        insert into memories_fts (memories_fts, rowid, content, summary, tags)
          values (
            'delete',
            (select rowid from memories_fts_map where memory_id = old.id),
            old.content,
            coalesce(old.summary, ''),
            coalesce(
              (select group_concat(value, ' ') from json_each(old.tags_json)),
              ''
            )
          );
        delete from memories_fts_map where memory_id = old.id;
      end
    `.execute(db);
  },
};
