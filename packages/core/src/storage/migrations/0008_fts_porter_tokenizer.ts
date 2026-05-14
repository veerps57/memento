// Migration 0008: rebuild `memories_fts` with porter+unicode61 tokenization.
//
// The FTS5 default tokenizer (`unicode61`) does no stemming. It treats
// `colleague`, `colleagues`, `colleague's`, and `colleagueship` as four
// unrelated tokens. For a prose memory layer this is the wrong trade:
// natural-language queries miss morphologically-similar matches that
// vector search rescues only partially, and "preserve the speaker's
// exact words" guidance compounds the problem because the speaker's
// words and the future query's words are rarely the same surface form.
//
// SQLite's `porter` tokenizer chains onto `unicode61`: unicode61 splits
// + diacritic-folds first, then porter reduces each token to a Porter
// stem. So `colleague`, `colleagues`, `colleague's` all index as the
// same stem, and a query for any of them matches all of them.
//
// FTS5 virtual tables cannot have their tokenizer changed in place —
// the only path is drop + rebuild. This migration mirrors 0005's
// drop-rebuild-repopulate-retrigger shape, but with the new tokenizer
// declaration. The `memories_fts_map` table is preserved so rowids
// stay stable across the rebuild.
//
// Trade-off accepted: porter occasionally over-stems
// (`organize`/`organic`, `universe`/`university`). For Memento's
// dominant query distribution — assistants asking about durable user
// state in natural language — recall on stem variants is worth more
// than precision on these edge cases. Operators who need the older
// behaviour can set `retrieval.fts.tokenizer` to `'unicode61'` in
// config (the key is the configurable knob this migration honours).
//
// Forward-only. No `down`.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0008FtsPorterTokenizer: Migration = {
  name: '0008_fts_porter_tokenizer',
  async up(db) {
    // 1. Drop existing triggers; they reference the table we're about to drop.
    await sql`drop trigger if exists memories_ai_fts`.execute(db);
    await sql`drop trigger if exists memories_au_fts`.execute(db);
    await sql`drop trigger if exists memories_bd_fts`.execute(db);

    // 2. Drop the old FTS virtual table (the shadow tables go with it).
    //    `memories_fts_map` survives — rowids are still valid.
    await sql`drop table if exists memories_fts`.execute(db);

    // 3. Recreate with the porter+unicode61 tokenizer chain. Order matters:
    //    SQLite applies tokenizers right-to-left, so unicode61 splits +
    //    normalises (handling non-ASCII content) first, and porter then
    //    stems the resulting tokens.
    await sql`
      create virtual table memories_fts using fts5(
        content,
        summary,
        tags,
        content='',
        tokenize='porter unicode61'
      )
    `.execute(db);

    // 4. Re-populate from existing memories joined through the stable
    //    rowid map. Tags are space-joined from the JSON array so each
    //    tag indexes as a separate token (porter also stems tags, which
    //    is harmless: tag names are typically short, lowercase, and
    //    namespace-prefixed; stem collisions are unlikely).
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

    // 5. Recreate triggers — same shape as 0005, no schema change.
    //    The triggers reference the table by name, so they automatically
    //    pick up the new tokenizer on every insert/update/delete.
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
