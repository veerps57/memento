// Migration 0007: complementary index on (status, last_confirmed_at desc).
//
// Verifies that:
//   1. The new index exists in sqlite_master after migration.
//   2. EXPLAIN QUERY PLAN on the canonical unscoped active-list query
//      references the new index for ordered retrieval (not a temp-tree sort).
//   3. The pre-existing scope-prefixed index is still present (no regression).

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

describe('0007_memories_status_lca_index', () => {
  it('creates the memories_status_lca index', async () => {
    const handle = open();
    await migrate(handle);

    const indexes = (
      handle.raw
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'memories' order by name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain('memories_status_lca');
  });

  it('keeps the pre-existing memories_scope_status_lca index', async () => {
    const handle = open();
    await migrate(handle);

    const indexes = (
      handle.raw
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'memories' order by name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain('memories_scope_status_lca');
  });

  it('plans an indexed ordered fetch for unscoped active list', async () => {
    const handle = open();
    await migrate(handle);

    // EXPLAIN QUERY PLAN for the canonical "newest active memories" read.
    const plan = handle.raw
      .prepare(
        "explain query plan select id from memories where status = 'active' order by last_confirmed_at desc limit 10",
      )
      .all() as { detail: string }[];

    const detail = plan.map((r) => r.detail).join(' | ');
    // Expect the new index to be used; the previous behaviour planned a TEMP B-TREE sort.
    expect(detail).toContain('memories_status_lca');
    expect(detail).not.toMatch(/use temp b-tree for order by/iu);
  });
});
