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

interface MasterRow {
  type: string;
  name: string;
}

function listObjects(handle: ReturnType<typeof open>, type: string): string[] {
  return (
    handle.raw
      .prepare('select name from sqlite_master where type = ? order by name')
      .all(type) as MasterRow[]
  ).map((r) => r.name);
}

describe('0001_initial_schema', () => {
  it('creates the expected base tables and indexes', async () => {
    const handle = open();
    await migrate(handle);

    const tables = listObjects(handle, 'table');
    // Includes `_memento_migrations` (from the runner) and the FTS5
    // shadow tables. Filter to the ones we own.
    expect(tables).toContain('memories');
    expect(tables).toContain('memory_events');
    expect(tables).toContain('memories_fts_map');

    // FTS5 creates several internal tables; the virtual table itself
    // is registered as `memories_fts`.
    expect(tables.some((t) => t === 'memories_fts')).toBe(true);

    const indexes = listObjects(handle, 'index');
    for (const expected of [
      'memories_scope_status_lca',
      'memories_status',
      'memories_supersedes',
      'memories_superseded_by',
      'memories_owner',
      'memory_events_memory_at',
      'memory_events_type_at',
    ]) {
      expect(indexes).toContain(expected);
    }
  });

  it('round-trips a memory row and its FTS shadow', async () => {
    const handle = open();
    await migrate(handle);

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
        '01HZZZZZZZZZZZZZZZZZZZZZZZ',
        '2026-04-25T00:00:00.000Z',
        1,
        'global',
        '{"type":"global"}',
        'local',
        'self',
        'fact',
        '{"type":"fact"}',
        '[]',
        0,
        'TypeScript strict mode is required',
        null,
        'active',
        0.9,
        '2026-04-25T00:00:00.000Z',
        null,
        null,
        null,
      );

    const ftsRows = handle.raw
      .prepare(
        `select m.id from memories m
           join memories_fts_map fm on fm.memory_id = m.id
           join memories_fts ft on ft.rowid = fm.rowid
          where memories_fts match 'typescript'`,
      )
      .all() as { id: string }[];
    expect(ftsRows).toHaveLength(1);
    expect(ftsRows[0]?.id).toBe('01HZZZZZZZZZZZZZZZZZZZZZZZ');
  });

  it('updates the FTS index when content changes', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000A', 'old payload text');
    handle.raw
      .prepare('update memories set content = ? where id = ?')
      .run('refreshed payload text', '01H0000000000000000000000A');

    const oldHits = handle.raw
      .prepare(`select count(*) as c from memories_fts where memories_fts match 'old'`)
      .get() as { c: number };
    const newHits = handle.raw
      .prepare(`select count(*) as c from memories_fts where memories_fts match 'refreshed'`)
      .get() as { c: number };
    expect(oldHits.c).toBe(0);
    expect(newHits.c).toBe(1);
  });

  it('removes the FTS row when a memory is deleted', async () => {
    const handle = open();
    await migrate(handle);
    insertMemory(handle, '01H0000000000000000000000B', 'transient content');
    handle.raw.prepare('delete from memories where id = ?').run('01H0000000000000000000000B');

    const hits = handle.raw
      .prepare(`select count(*) as c from memories_fts where memories_fts match 'transient'`)
      .get() as { c: number };
    expect(hits.c).toBe(0);

    const map = handle.raw
      .prepare('select count(*) as c from memories_fts_map where memory_id = ?')
      .get('01H0000000000000000000000B') as { c: number };
    expect(map.c).toBe(0);
  });

  it('rejects rows that violate schema CHECKs', async () => {
    const handle = open();
    await migrate(handle);
    expect(() => insertMemory(handle, '01H0000000000000000000000C', 'x', { pinned: 2 })).toThrow();
    expect(() =>
      insertMemory(handle, '01H0000000000000000000000D', 'x', {
        storedConfidence: 1.5,
      }),
    ).toThrow();
    expect(() =>
      insertMemory(handle, '01H0000000000000000000000E', 'x', {
        status: 'bogus',
      }),
    ).toThrow();
    expect(() =>
      insertMemory(handle, '01H0000000000000000000000F', 'x', {
        lastConfirmedAt: '1999-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('enforces the foreign-key reference from memory_events to memories', async () => {
    const handle = open();
    await migrate(handle);
    expect(() =>
      handle.raw
        .prepare(
          `insert into memory_events (
             id, memory_id, at, actor_type, actor_json, type, payload_json, scrub_report_json
           ) values (?,?,?,?,?,?,?,?)`,
        )
        .run(
          '01EVENT00000000000000000A',
          '01MISSING00000000000000000',
          '2026-04-25T00:00:00.000Z',
          'system',
          '{"type":"system"}',
          'created',
          '{}',
          null,
        ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('runner reports the migration applied once and skipped thereafter', async () => {
    const handle = open();
    const first = await migrateToLatest(handle.db, MIGRATIONS);
    const second = await migrateToLatest(handle.db, MIGRATIONS);
    expect(first.find((o) => o.name === '0001_initial_schema')).toEqual({
      name: '0001_initial_schema',
      status: 'applied',
    });
    expect(second.find((o) => o.name === '0001_initial_schema')).toEqual({
      name: '0001_initial_schema',
      status: 'skipped',
    });
  });
});

interface InsertOverrides {
  pinned?: number;
  storedConfidence?: number;
  status?: string;
  lastConfirmedAt?: string;
}

function insertMemory(
  handle: ReturnType<typeof open>,
  id: string,
  content: string,
  overrides: InsertOverrides = {},
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
      '[]',
      overrides.pinned ?? 0,
      content,
      null,
      overrides.status ?? 'active',
      overrides.storedConfidence ?? 0.9,
      overrides.lastConfirmedAt ?? '2026-04-25T00:00:00.000Z',
      null,
      null,
      null,
    );
}

// Make sure the side-effect (the import above pulls in MIGRATIONS)
// is observable to the test runner; avoids tree-shaking concerns
// in custom builders that might otherwise drop the registry.
void sql;
