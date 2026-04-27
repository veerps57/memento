import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import type { Migration } from '../../src/storage/migrate.js';
import { MementoMigrationDowngradeError, migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

interface OpenHandle {
  close(): void;
}

const handles: OpenHandle[] = [];

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
});

describe('migrateToLatest', () => {
  it('returns an empty outcome list when no migrations are registered', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    const outcomes = await migrateToLatest(handle.db, []);
    expect(outcomes).toEqual([]);
  });

  it('creates the bookkeeping table on first invocation and is idempotent', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, []);
    await migrateToLatest(handle.db, []);
    const tables = handle.raw
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('_memento_migrations');
  });

  it('applies a fake migration once and skips it on the second run', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);

    let invocations = 0;
    const fake: Migration = {
      name: '0000_smoke',
      async up(db) {
        invocations += 1;
        await sql`create table smoke (x integer not null)`.execute(db);
      },
    };

    const first = await migrateToLatest(handle.db, [fake]);
    expect(first).toEqual([{ name: '0000_smoke', status: 'applied' }]);
    expect(invocations).toBe(1);

    const second = await migrateToLatest(handle.db, [fake]);
    expect(second).toEqual([{ name: '0000_smoke', status: 'skipped' }]);
    expect(invocations).toBe(1);

    handle.raw.prepare('insert into smoke (x) values (?)').run(1);
  });

  it('rolls back when a migration throws and retries on the next run', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);

    let attempts = 0;
    const flaky: Migration = {
      name: '0000_flaky',
      async up(db) {
        attempts += 1;
        await sql`create table flaky (x integer not null)`.execute(db);
        if (attempts === 1) {
          throw new Error('boom');
        }
      },
    };

    await expect(migrateToLatest(handle.db, [flaky])).rejects.toThrow('boom');

    const tablesAfterFailure = handle.raw
      .prepare("select name from sqlite_master where type = 'table' and name = 'flaky'")
      .all() as { name: string }[];
    expect(tablesAfterFailure).toEqual([]);

    const outcomes = await migrateToLatest(handle.db, [flaky]);
    expect(outcomes).toEqual([{ name: '0000_flaky', status: 'applied' }]);
    expect(attempts).toBe(2);
  });

  it('applies a sequence in order and reports per-migration outcomes', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);

    const calls: string[] = [];
    const m1: Migration = {
      name: '0001_one',
      async up(db) {
        calls.push('one');
        await sql`create table one (x integer)`.execute(db);
      },
    };
    const m2: Migration = {
      name: '0002_two',
      async up(db) {
        calls.push('two');
        await sql`create table two (x integer)`.execute(db);
      },
    };
    const outcomes = await migrateToLatest(handle.db, [m1, m2]);
    expect(outcomes).toEqual([
      { name: '0001_one', status: 'applied' },
      { name: '0002_two', status: 'applied' },
    ]);
    expect(calls).toEqual(['one', 'two']);
  });
});

describe('migrateToLatest — downgrade detection (P3.4)', () => {
  // P3.4: opening a v(N) database with a v(N-1) build must
  // either keep working or fail up front with a single,
  // structured error. We choose "fail up front" — silently
  // operating on an unknown schema is the worst outcome. The
  // test simulates the scenario by writing an unknown
  // migration name into the bookkeeping table after a clean
  // migrate, then re-running with the same registry (the older
  // build's view).

  it('rejects a database whose bookkeeping table records an unknown migration', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);

    // First, migrate the database to "current" with the real registry.
    await migrateToLatest(handle.db, MIGRATIONS);

    // Simulate a future build having added migration `9999_future`.
    handle.raw
      .prepare('insert into _memento_migrations (name, run_at) values (?, ?)')
      .run('9999_future_table', new Date().toISOString());

    // Now an older build (whose registry does not know about the
    // future migration) tries to open the same database.
    await expect(migrateToLatest(handle.db, MIGRATIONS)).rejects.toThrow(
      MementoMigrationDowngradeError,
    );
  });

  it('the downgrade error names the unknown migrations and carries STORAGE_ERROR code', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);

    handle.raw
      .prepare('insert into _memento_migrations (name, run_at) values (?, ?)')
      .run('9999_future_table', new Date().toISOString());
    handle.raw
      .prepare('insert into _memento_migrations (name, run_at) values (?, ?)')
      .run('9998_other_future', new Date().toISOString());

    let caught: unknown;
    try {
      await migrateToLatest(handle.db, MIGRATIONS);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MementoMigrationDowngradeError);
    const err = caught as MementoMigrationDowngradeError;
    expect(err.code).toBe('STORAGE_ERROR');
    // Sorted lexicographically so the message is stable.
    expect(err.unknownMigrations).toEqual(['9998_other_future', '9999_future_table']);
    expect(err.message).toContain('9998_other_future');
    expect(err.message).toContain('9999_future_table');
    expect(err.message).toContain('older than the database');
  });

  it('does not mutate the database when the downgrade error fires', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);

    handle.raw
      .prepare('insert into _memento_migrations (name, run_at) values (?, ?)')
      .run('9999_future_table', new Date().toISOString());

    // Snapshot bookkeeping before the failed downgrade.
    const before = handle.raw
      .prepare('select name from _memento_migrations order by name')
      .all() as { name: string }[];

    await expect(migrateToLatest(handle.db, MIGRATIONS)).rejects.toThrow(
      MementoMigrationDowngradeError,
    );

    const after = handle.raw
      .prepare('select name from _memento_migrations order by name')
      .all() as { name: string }[];
    expect(after).toEqual(before);
  });

  it('a clean current-build run with no future migrations is unaffected', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    const first = await migrateToLatest(handle.db, MIGRATIONS);
    expect(first.every((o) => o.status === 'applied')).toBe(true);

    // Re-run with the same registry — every migration skipped, no error.
    const second = await migrateToLatest(handle.db, MIGRATIONS);
    expect(second.every((o) => o.status === 'skipped')).toBe(true);
  });
});
