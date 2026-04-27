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
  name: string;
}

function listObjects(handle: ReturnType<typeof open>, type: string): string[] {
  return (
    handle.raw
      .prepare('select name from sqlite_master where type = ? order by name')
      .all(type) as MasterRow[]
  ).map((r) => r.name);
}

// A pair of memory rows is a precondition for any conflict test;
// the helper keeps the per-test fixture small and obvious.
function seedMemoryPair(handle: ReturnType<typeof open>, ids: [string, string]): void {
  const stmt = handle.raw.prepare(
    `insert into memories (
       id, created_at, schema_version, scope_type, scope_json,
       owner_type, owner_id, kind_type, kind_json, tags_json,
       pinned, content, summary, status, stored_confidence,
       last_confirmed_at, supersedes, superseded_by, embedding_json
     ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const id of ids) {
    stmt.run(
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
      0,
      `content for ${id}`,
      null,
      'active',
      0.9,
      '2026-04-25T00:00:00.000Z',
      null,
      null,
      null,
    );
  }
}

function insertConflict(
  handle: ReturnType<typeof open>,
  id: string,
  newId: string,
  conflictingId: string,
  resolved?: { resolvedAt: string; resolution: string },
): void {
  handle.raw
    .prepare(
      `insert into conflicts (
         id, new_memory_id, conflicting_memory_id, kind, evidence_json,
         opened_at, resolved_at, resolution
       ) values (?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      newId,
      conflictingId,
      'fact',
      'null',
      '2026-04-25T00:00:00.000Z',
      resolved?.resolvedAt ?? null,
      resolved?.resolution ?? null,
    );
}

describe('0002_config_and_conflicts', () => {
  it('creates the expected tables and indexes', async () => {
    const handle = open();
    await migrate(handle);

    const tables = listObjects(handle, 'table');
    expect(tables).toEqual(
      expect.arrayContaining(['config_events', 'conflicts', 'conflict_events']),
    );

    const indexes = listObjects(handle, 'index');
    for (const expected of [
      'config_events_key_at',
      'config_events_source_at',
      'conflicts_open',
      'conflicts_new_memory',
      'conflicts_conflicting_memory',
      'conflict_events_conflict_at',
      'conflict_events_type_at',
    ]) {
      expect(indexes).toContain(expected);
    }
  });

  it('round-trips a config_event with NULL old_value distinct from JSON null', async () => {
    const handle = open();
    await migrate(handle);

    const stmt = handle.raw.prepare(
      `insert into config_events (
         id, key, old_value_json, new_value_json,
         source, actor_type, actor_json, at
       ) values (?,?,?,?,?,?,?,?)`,
    );
    // first set: old SQL-NULL, new JSON literal "null" (i.e. user
    // explicitly set the value to null)
    stmt.run(
      '01CFG00000000000000000001',
      'retrieval.vector.enabled',
      null,
      'null',
      'cli',
      'cli',
      '{"type":"cli"}',
      '2026-04-25T00:00:00.000Z',
    );
    // unset: new SQL-NULL
    stmt.run(
      '01CFG00000000000000000002',
      'retrieval.vector.enabled',
      'null',
      null,
      'mcp',
      'mcp',
      '{"type":"mcp","agent":"claude/0.5"}',
      '2026-04-25T00:00:01.000Z',
    );

    const rows = handle.raw
      .prepare('select id, old_value_json, new_value_json from config_events order by id')
      .all() as {
      id: string;
      old_value_json: string | null;
      new_value_json: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.old_value_json).toBeNull();
    expect(rows[0]?.new_value_json).toBe('null');
    expect(rows[1]?.old_value_json).toBe('null');
    expect(rows[1]?.new_value_json).toBeNull();
  });

  it('rejects config_event rows with an invalid source or actor_type', async () => {
    const handle = open();
    await migrate(handle);
    const stmt = handle.raw.prepare(
      `insert into config_events (
         id, key, old_value_json, new_value_json,
         source, actor_type, actor_json, at
       ) values (?,?,?,?,?,?,?,?)`,
    );
    expect(() =>
      stmt.run(
        '01CFG00000000000000000003',
        'k.v',
        null,
        'null',
        'bogus',
        'cli',
        '{}',
        '2026-04-25T00:00:00.000Z',
      ),
    ).toThrow();
    expect(() =>
      stmt.run(
        '01CFG00000000000000000004',
        'k.v',
        null,
        'null',
        'cli',
        'user',
        '{}',
        '2026-04-25T00:00:00.000Z',
      ),
    ).toThrow();
  });

  it('inserts an open conflict and accepts a matched resolved/resolution pair', async () => {
    const handle = open();
    await migrate(handle);
    seedMemoryPair(handle, ['01MEM0000000000000000000A', '01MEM0000000000000000000B']);
    insertConflict(
      handle,
      '01CONF0000000000000000001',
      '01MEM0000000000000000000A',
      '01MEM0000000000000000000B',
    );
    insertConflict(
      handle,
      '01CONF0000000000000000002',
      '01MEM0000000000000000000A',
      '01MEM0000000000000000000B',
      { resolvedAt: '2026-04-25T01:00:00.000Z', resolution: 'accept-new' },
    );

    const openCount = handle.raw
      .prepare('select count(*) as c from conflicts where resolved_at is null')
      .get() as { c: number };
    expect(openCount.c).toBe(1);
  });

  it('rejects a conflict whose resolution / resolved_at disagree', async () => {
    const handle = open();
    await migrate(handle);
    seedMemoryPair(handle, ['01MEM0000000000000000000C', '01MEM0000000000000000000D']);

    expect(() =>
      insertConflict(
        handle,
        '01CONF0000000000000000003',
        '01MEM0000000000000000000C',
        '01MEM0000000000000000000D',
        // resolved_at present but resolution null violates the
        // "both null or both set" CHECK.
        {
          resolvedAt: '2026-04-25T01:00:00.000Z',
          resolution: null as unknown as string,
        },
      ),
    ).toThrow();
  });

  it('rejects self-conflicts and out-of-order resolution timestamps', async () => {
    const handle = open();
    await migrate(handle);
    seedMemoryPair(handle, ['01MEM0000000000000000000E', '01MEM0000000000000000000F']);

    expect(() =>
      insertConflict(
        handle,
        '01CONF0000000000000000004',
        '01MEM0000000000000000000E',
        '01MEM0000000000000000000E',
      ),
    ).toThrow();

    expect(() =>
      handle.raw
        .prepare(
          `insert into conflicts (
             id, new_memory_id, conflicting_memory_id, kind, evidence_json,
             opened_at, resolved_at, resolution
           ) values (?,?,?,?,?,?,?,?)`,
        )
        .run(
          '01CONF0000000000000000005',
          '01MEM0000000000000000000E',
          '01MEM0000000000000000000F',
          'fact',
          'null',
          '2026-04-25T02:00:00.000Z',
          '2026-04-25T01:00:00.000Z',
          'accept-new',
        ),
    ).toThrow();
  });

  it('enforces FK from conflict_events to conflicts and from conflicts to memories', async () => {
    const handle = open();
    await migrate(handle);

    expect(() =>
      handle.raw
        .prepare(
          `insert into conflicts (
             id, new_memory_id, conflicting_memory_id, kind, evidence_json,
             opened_at, resolved_at, resolution
           ) values (?,?,?,?,?,?,?,?)`,
        )
        .run(
          '01CONF0000000000000000006',
          '01MISSING000000000000000A',
          '01MISSING000000000000000B',
          'fact',
          'null',
          '2026-04-25T00:00:00.000Z',
          null,
          null,
        ),
    ).toThrow(/FOREIGN KEY/i);

    expect(() =>
      handle.raw
        .prepare(
          `insert into conflict_events (
             id, conflict_id, at, actor_type, actor_json, type, payload_json
           ) values (?,?,?,?,?,?,?)`,
        )
        .run(
          '01CEVT0000000000000000001',
          '01CONFMISSING0000000000001',
          '2026-04-25T00:00:00.000Z',
          'system',
          '{"type":"system"}',
          'opened',
          '{}',
        ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('appends both event variants and indexes them by (conflict_id, at)', async () => {
    const handle = open();
    await migrate(handle);
    seedMemoryPair(handle, ['01MEM0000000000000000000G', '01MEM0000000000000000000H']);
    insertConflict(
      handle,
      '01CONF0000000000000000007',
      '01MEM0000000000000000000G',
      '01MEM0000000000000000000H',
    );

    const stmt = handle.raw.prepare(
      `insert into conflict_events (
         id, conflict_id, at, actor_type, actor_json, type, payload_json
       ) values (?,?,?,?,?,?,?)`,
    );
    stmt.run(
      '01CEVT0000000000000000010',
      '01CONF0000000000000000007',
      '2026-04-25T00:00:00.000Z',
      'system',
      '{"type":"system"}',
      'opened',
      '{"newMemoryId":"a","conflictingMemoryId":"b","kind":"fact","evidence":null}',
    );
    stmt.run(
      '01CEVT0000000000000000011',
      '01CONF0000000000000000007',
      '2026-04-25T01:00:00.000Z',
      'cli',
      '{"type":"cli"}',
      'resolved',
      '{"resolution":"accept-new"}',
    );

    const rows = handle.raw
      .prepare(
        `select type from conflict_events
          where conflict_id = ? order by at asc`,
      )
      .all('01CONF0000000000000000007') as { type: string }[];
    expect(rows.map((r) => r.type)).toEqual(['opened', 'resolved']);
  });

  it('runner reports each migration applied once and skipped thereafter', async () => {
    const handle = open();
    const first = await migrateToLatest(handle.db, MIGRATIONS);
    const second = await migrateToLatest(handle.db, MIGRATIONS);
    expect(first.map((o) => o.status)).toEqual(first.map(() => 'applied'));
    expect(second.map((o) => o.status)).toEqual(second.map(() => 'skipped'));
    expect(first.map((o) => o.name)).toContain('0002_config_and_conflicts');
  });
});
