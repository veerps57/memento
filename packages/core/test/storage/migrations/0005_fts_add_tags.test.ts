// Migration 0005: FTS5 tag indexing — end-to-end coverage.
//
// Verifies that:
//   1. The rebuilt FTS table includes the `tags` column.
//   2. Existing memories have their tags indexed after migration.
//   3. Insert trigger populates tags in FTS.
//   4. Update trigger on `tags_json` syncs FTS.
//   5. Delete trigger removes FTS entries (including tags).

import { sql } from 'kysely';
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

describe('0005_fts_add_tags', () => {
  it('indexes tags so they are searchable via FTS MATCH', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'some content', ['architecture', 'config']);
    insertMemory(handle, '01H0000000000000000000000B', 'other content', ['testing']);

    expect(ftsMatch(handle, 'architecture')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'config')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'testing')).toEqual(['01H0000000000000000000000B']);
  });

  it('indexes colon-namespaced tags as searchable tokens', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'note', ['project:memento']);
    insertMemory(handle, '01H0000000000000000000000B', 'other', ['unrelated']);

    // FTS5's unicode61 tokenizer splits on `:`, so both halves
    // are indexed as individual tokens. Searching for either
    // component finds the memory.
    expect(ftsMatch(handle, 'memento')).toEqual(['01H0000000000000000000000A']);
    // Use the `tags:` column prefix to restrict to the tags column only.
    expect(ftsMatch(handle, 'tags:memento')).toEqual(['01H0000000000000000000000A']);
  });

  it('updates FTS when tags_json changes', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'stable content', ['oldtag']);

    expect(ftsMatch(handle, 'oldtag')).toEqual(['01H0000000000000000000000A']);

    handle.raw
      .prepare('update memories set tags_json = ? where id = ?')
      .run('["newtag"]', '01H0000000000000000000000A');

    expect(ftsMatch(handle, 'oldtag')).toEqual([]);
    expect(ftsMatch(handle, 'newtag')).toEqual(['01H0000000000000000000000A']);
  });

  it('removes FTS entries (including tags) on delete', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'deletable', ['ephemeral']);

    expect(ftsMatch(handle, 'ephemeral')).toEqual(['01H0000000000000000000000A']);

    handle.raw.prepare('delete from memories where id = ?').run('01H0000000000000000000000A');

    expect(ftsMatch(handle, 'ephemeral')).toEqual([]);
    const map = handle.raw
      .prepare('select count(*) as c from memories_fts_map where memory_id = ?')
      .get('01H0000000000000000000000A') as { c: number };
    expect(map.c).toBe(0);
  });

  it('re-populates existing memory tags during migration', async () => {
    // Simulate pre-migration state by running migrations up to
    // 0004, inserting a row, then running the rest.
    const handle = open();
    const pre0005 = MIGRATIONS.slice(0, 4);
    await migrateToLatest(handle.db, pre0005);

    // Insert a memory with tags before migration 0005 runs.
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
        '["preexisting","data"]',
        0,
        'pre-migration content',
        null,
        'active',
        0.9,
        '2026-04-25T00:00:00.000Z',
        null,
        null,
        null,
        0,
      );

    // Now run migration 0005.
    await migrateToLatest(handle.db, MIGRATIONS);

    // The pre-existing tags should be searchable via FTS.
    expect(ftsMatch(handle, 'preexisting')).toEqual(['01H0000000000000000000000A']);
    expect(ftsMatch(handle, 'data')).toEqual(['01H0000000000000000000000A']);
    // Content should still be searchable too.
    expect(ftsMatch(handle, 'migration')).toEqual(['01H0000000000000000000000A']);
  });

  it('handles memories with empty tags gracefully', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'no tags here', []);

    // Should still be findable by content.
    expect(ftsMatch(handle, 'tags')).toEqual(['01H0000000000000000000000A']);
  });
});

// Keep the import observable to the test runner.
void sql;
