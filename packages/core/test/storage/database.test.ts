import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { rmTmpSync } from '../_helpers/rm-tmp.js';

interface OpenHandle {
  close(): void;
}

const handles: OpenHandle[] = [];

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
});

function track<H extends OpenHandle>(h: H): H {
  handles.push(h);
  return h;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'memento-db-'));
  try {
    return fn(dir);
  } finally {
    // Drain any open handles tracked by the test before deleting
    // the directory; on Windows, better-sqlite3 holds the file
    // mapping briefly after `close()`, so the helper retries.
    while (handles.length > 0) {
      handles.pop()?.close();
    }
    rmTmpSync(dir);
  }
}

describe('openDatabase', () => {
  it('opens an in-memory database that round-trips a SQL statement', () => {
    const handle = track(openDatabase({ path: ':memory:' }));
    handle.raw.exec('create table t (x integer not null)');
    handle.raw.prepare('insert into t (x) values (?)').run(1);
    const row = handle.raw.prepare('select x from t').get() as { x: number };
    expect(row.x).toBe(1);
  });

  it('exposes a typed Kysely instance bound to the same connection', async () => {
    const handle = track(openDatabase({ path: ':memory:' }));
    handle.raw.exec('create table t (x integer not null)');
    handle.raw.prepare('insert into t (x) values (?)').run(7);
    const result = await sql<{ x: number }>`select x from t`.execute(handle.db);
    expect(result.rows[0]?.x).toBe(7);
  });

  it('applies the canonical PRAGMA set on a file-backed database', () => {
    withTempDir((dir) => {
      const file = join(dir, 'memento.sqlite');
      const handle = track(openDatabase({ path: file, busyTimeoutMs: 1234 }));
      const journal = handle.raw.pragma('journal_mode', { simple: true });
      const fk = handle.raw.pragma('foreign_keys', { simple: true });
      const sync = handle.raw.pragma('synchronous', { simple: true });
      const busy = handle.raw.pragma('busy_timeout', { simple: true });
      const temp = handle.raw.pragma('temp_store', { simple: true });
      expect(String(journal).toLowerCase()).toBe('wal');
      expect(Number(fk)).toBe(1);
      // synchronous: 1 = NORMAL.
      expect(Number(sync)).toBe(1);
      expect(Number(busy)).toBe(1234);
      // temp_store: 2 = MEMORY.
      expect(Number(temp)).toBe(2);
    });
  });

  it('skips WAL on :memory: (PRAGMA journal_mode reports memory)', () => {
    const handle = track(openDatabase({ path: ':memory:' }));
    const journal = handle.raw.pragma('journal_mode', { simple: true });
    expect(String(journal).toLowerCase()).toBe('memory');
  });

  it('opens read-only and rejects writes', () => {
    withTempDir((dir) => {
      const file = join(dir, 'memento.sqlite');
      // Seed a table while writable.
      const writable = new Database(file);
      writable.exec('create table t (x integer not null)');
      writable.prepare('insert into t (x) values (?)').run(42);
      writable.close();

      const handle = track(openDatabase({ path: file, readonly: true }));
      const row = handle.raw.prepare('select x from t').get() as { x: number };
      expect(row.x).toBe(42);
      expect(() => handle.raw.prepare('insert into t (x) values (?)').run(99)).toThrow();
    });
  });

  it('close() is idempotent', () => {
    const handle = openDatabase({ path: ':memory:' });
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it('uses the default busy_timeout when none is provided', () => {
    withTempDir((dir) => {
      const file = join(dir, 'memento.sqlite');
      const handle = track(openDatabase({ path: file }));
      const busy = handle.raw.pragma('busy_timeout', { simple: true });
      expect(Number(busy)).toBe(5_000);
    });
  });
});
