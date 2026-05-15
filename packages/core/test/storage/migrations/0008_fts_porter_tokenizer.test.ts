// Migration 0008: porter+unicode61 tokenization — end-to-end coverage.
//
// Verifies that:
//   1. The rebuilt FTS table matches stem variants (colleague /
//      colleagues / colleague's resolve to the same stem, baking /
//      bakes / baked resolve to the same stem).
//   2. Pre-migration memories are re-indexed under the new tokenizer.
//   3. Insert trigger uses the new tokenizer for new memories.
//   4. Update trigger picks up stem-equivalent content changes.
//   5. Delete trigger still purges FTS entries cleanly.
//   6. Non-ASCII content still tokenizes (porter chains onto
//      unicode61, which handles diacritics and non-Latin scripts).

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/storage/database.js';
import { migrateToLatest } from '../../../src/storage/migrate.js';
import { MIGRATIONS } from '../../../src/storage/migrations/index.js';

interface OpenHandle {
  close(): void;
}

const handles: OpenHandle[] = [];

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
});

function open() {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  return handle;
}

async function migrate(handle: ReturnType<typeof open>): Promise<void> {
  await migrateToLatest(handle.db, MIGRATIONS);
}

function insertMemory(
  handle: ReturnType<typeof open>,
  id: string,
  content: string,
  tags: string[] = [],
): void {
  handle.raw
    .prepare(
      `insert into memories (
        id, created_at, schema_version, scope_type, scope_json,
        owner_type, owner_id, kind_type, kind_json, tags_json,
        pinned, content, summary, status, stored_confidence,
        last_confirmed_at, supersedes, superseded_by, embedding_json
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      '2026-04-25T00:00:00.000Z',
      1,
      'global',
      '{"type":"global"}',
      'local',
      'self',
      'fact',
      '{"type":"fact"}',
      JSON.stringify(tags),
      0,
      content,
      null,
      'active',
      0.9,
      '2026-04-25T00:00:00.000Z',
      null,
      null,
      null,
    );
}

function ftsMatch(handle: ReturnType<typeof open>, query: string): string[] {
  return (
    handle.raw
      .prepare(
        `select m.id from memories m
           join memories_fts_map fm on fm.memory_id = m.id
           join memories_fts ft on ft.rowid = fm.rowid
          where memories_fts match ?`,
      )
      .all(query) as { id: string }[]
  ).map((r) => r.id);
}

describe('0008_fts_porter_tokenizer', () => {
  it('matches plural / possessive variants of the same stem', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(
      handle,
      '01H0000000000000000000000A',
      "The user previously made a lemon poppyseed cake for a colleague's going-away party.",
    );
    insertMemory(handle, '01H0000000000000000000000B', 'Some unrelated content about hiking.');

    // Singular and plural both stem to the same root as the stored
    // possessive form ("colleague's"). FTS5 MATCH syntax reserves the
    // apostrophe so we can't pass it directly in a query, but the
    // realistic direction is what matters: a future-question with
    // "colleagues" finds a memory containing "colleague's".
    expect(ftsMatch(handle, 'colleague')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'colleagues')).toEqual(['01H0000000000000000000000A']);
  });

  it('matches verb-form variants of the same stem', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(
      handle,
      '01H0000000000000000000000A',
      'The user has been baking cookies on the weekends.',
    );

    expect(ftsMatch(handle, 'bake')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'bakes')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'baked')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'baking')).toEqual(['01H0000000000000000000000A']);
  });

  it('re-indexes existing memories under the porter tokenizer', async () => {
    // Simulate a pre-0008 install: run migrations up to 0007 with the
    // old unicode61 tokenizer, write a memory, then run 0008.
    const handle = open();
    const pre0008 = MIGRATIONS.slice(0, 7);
    await migrateToLatest(handle.db, pre0008);

    handle.raw
      .prepare(
        `insert into memories (
          id, created_at, schema_version, scope_type, scope_json,
          owner_type, owner_id, kind_type, kind_json, tags_json,
          pinned, content, summary, status, stored_confidence,
          last_confirmed_at, supersedes, superseded_by, embedding_json, sensitive
        ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        '01H0000000000000000000000A',
        '2026-04-25T00:00:00.000Z',
        1,
        'global',
        '{"type":"global"}',
        'local',
        'self',
        'fact',
        '{"type":"fact"}',
        '["baking","weekend"]',
        0,
        'The user has been baking cookies on the weekends.',
        null,
        'active',
        0.9,
        '2026-04-25T00:00:00.000Z',
        null,
        null,
        null,
        0,
      );

    // Pre-0008 the row is indexed under unicode61 (literal "baking"
    // and "weekends"). After 0008 the stem-equivalent queries should hit.
    await migrateToLatest(handle.db, MIGRATIONS);

    expect(ftsMatch(handle, 'bake')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'weekend')).toEqual(['01H0000000000000000000000A']);
    // Tags stem too; the stored tag is "baking", a query for "bakes" hits.
    expect(ftsMatch(handle, 'tags:bakes')).toEqual(['01H0000000000000000000000A']);
  });

  it('insert trigger uses the new tokenizer for memories created post-migration', async () => {
    const handle = open();
    await migrate(handle);

    // Insert AFTER migration runs — the insert trigger fires and the
    // FTS row is created under porter.
    insertMemory(
      handle,
      '01H0000000000000000000000A',
      'The user researched adoption agencies last spring.',
    );

    expect(ftsMatch(handle, 'research')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'researches')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'researched')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'agencies')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'agency')).toEqual(['01H0000000000000000000000A']);
  });

  it('update trigger re-indexes stem-equivalent content changes', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'The user was running every morning.');

    expect(ftsMatch(handle, 'run')).toEqual(['01H0000000000000000000000A']);

    handle.raw
      .prepare('update memories set content = ? where id = ?')
      .run('The user switched to cycling every morning.', '01H0000000000000000000000A');

    expect(ftsMatch(handle, 'run')).toEqual([]);
    expect(ftsMatch(handle, 'cycling')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'cycles')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'cycled')).toEqual(['01H0000000000000000000000A']);
  });

  it('delete trigger removes FTS entries and the map row', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'A memory about gardening tomatoes.');

    expect(ftsMatch(handle, 'garden')).toEqual(['01H0000000000000000000000A']);

    handle.raw.prepare('delete from memories where id = ?').run('01H0000000000000000000000A');

    expect(ftsMatch(handle, 'garden')).toEqual([]);
    const map = handle.raw
      .prepare('select count(*) as c from memories_fts_map where memory_id = ?')
      .get('01H0000000000000000000000A') as { c: number };
    expect(map.c).toBe(0);
  });

  it('preserves non-ASCII content (porter chains onto unicode61)', async () => {
    const handle = open();
    await migrate(handle);
    // Diacritics, German umlaut, Japanese — all should still be
    // findable. unicode61's diacritic-folding fires before porter,
    // so "café" indexes as "cafe" and remains queryable.
    insertMemory(
      handle,
      '01H0000000000000000000000A',
      'The user visited a small café in München and ordered ラーメン.',
    );

    // Diacritic-folded ASCII match.
    expect(ftsMatch(handle, 'cafe')).toEqual(['01H0000000000000000000000A']);
    // Original diacritic-bearing form also hits (folding is symmetric).
    expect(ftsMatch(handle, 'café')).toEqual(['01H0000000000000000000000A']);
    // German umlaut form similar.
    expect(ftsMatch(handle, 'munchen')).toEqual(['01H0000000000000000000000A']);
    // Non-Latin script is unaffected by stemming and still indexes.
    expect(ftsMatch(handle, 'ラーメン')).toEqual(['01H0000000000000000000000A']);
  });
});
