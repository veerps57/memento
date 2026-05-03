// Migration 0006: widened CHECK constraint on memory_events.type.
//
// Verifies that:
//   1. Pre-existing rows with the original event types survive
//      the rebuild unchanged.
//   2. The new `'imported'` value is accepted by the constraint.
//   3. Unknown values (e.g. `'deleted'`) are still rejected.
//   4. Indexes are recreated on the new table.

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

function insertMemory(handle: ReturnType<typeof open>, id: string): void {
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
      0,
      'hello',
      null,
      'active',
      1.0,
      '2026-04-25T00:00:00.000Z',
      null,
      null,
      null,
    );
}

function insertEvent(
  handle: ReturnType<typeof open>,
  eventId: string,
  memoryId: string,
  type: string,
  payloadJson: string,
): void {
  handle.raw
    .prepare(
      `insert into memory_events (id, memory_id, at, actor_type, actor_json, type, payload_json, scrub_report_json)
       values (?,?,?,?,?,?,?,?)`,
    )
    .run(
      eventId,
      memoryId,
      '2026-04-25T00:00:00.000Z',
      'cli',
      '{"type":"cli"}',
      type,
      payloadJson,
      null,
    );
}

describe('0006_memory_events_imported_type', () => {
  it('preserves pre-existing rows across the table rebuild', async () => {
    const handle = open();
    await migrate(handle);

    insertMemory(handle, 'mem-001');
    insertEvent(handle, 'evt-001', 'mem-001', 'created', '{}');
    insertEvent(handle, 'evt-002', 'mem-001', 'confirmed', '{}');

    const rows = handle.raw.prepare('select id, type from memory_events order by id').all() as {
      id: string;
      type: string;
    }[];
    expect(rows).toEqual([
      { id: 'evt-001', type: 'created' },
      { id: 'evt-002', type: 'confirmed' },
    ]);
  });

  it("accepts the new 'imported' event type", async () => {
    const handle = open();
    await migrate(handle);

    insertMemory(handle, 'mem-002');
    expect(() =>
      insertEvent(
        handle,
        'evt-003',
        'mem-002',
        'imported',
        JSON.stringify({
          source: {
            mementoVersion: '0.6.0',
            exportedAt: '2026-04-25T00:00:00.000Z',
            sha256: 'a'.repeat(64),
          },
          originalEvents: [],
        }),
      ),
    ).not.toThrow();
  });

  it('still rejects unknown event types via the CHECK constraint', async () => {
    const handle = open();
    await migrate(handle);

    insertMemory(handle, 'mem-003');
    expect(() => insertEvent(handle, 'evt-004', 'mem-003', 'deleted', '{}')).toThrow(
      /CHECK constraint failed/u,
    );
  });

  it('recreates the (memory_id, at) and (type, at) indexes', async () => {
    const handle = open();
    await migrate(handle);

    const indexes = (
      handle.raw
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'memory_events' order by name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain('memory_events_memory_at');
    expect(indexes).toContain('memory_events_type_at');
  });
});
