// Database wrapper for the Memento storage layer.
//
// Wraps `better-sqlite3` and a typed Kysely instance over the same
// connection. Concentrates *every* PRAGMA we depend on in one place
// so behaviour is reproducible regardless of which workspace opens
// the file. ADR-0001 explains why SQLite is the storage engine.

import { CONFIG_KEYS } from '@psraghuveer/memento-schema';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { MementoSchema } from './schema.js';

/**
 * Options accepted by {@link openDatabase}.
 *
 * `path` is either an absolute file path or `':memory:'`. We never
 * silently relativise — see ADR on storage paths.
 *
 * `busyTimeoutMs` controls how long writers wait for the lock before
 * `SQLITE_BUSY` surfaces. Default 5 s matches the documented
 * `storage.busyTimeoutMs` config key.
 *
 * `readonly` opens the file in read-only mode for tools that must
 * not mutate state (e.g. `memento export`). Writes via Kysely will
 * raise; tests cover that.
 */
export interface OpenDatabaseOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly readonly?: boolean;
}

/**
 * Handle returned by {@link openDatabase}. Holds the raw
 * better-sqlite3 connection (for migrations and PRAGMA inspection)
 * and the typed Kysely instance the rest of the engine uses.
 *
 * `close()` is idempotent so repository tests can call it from
 * `afterEach` without tracking whether the handle was ever opened.
 */
export interface MementoDatabase {
  readonly raw: BetterSqlite3Database;
  readonly db: Kysely<MementoSchema>;
  close(): void;
}

const DEFAULT_BUSY_TIMEOUT_MS = CONFIG_KEYS['storage.busyTimeoutMs'].default;

/**
 * Open a Memento database at `path`, apply the canonical PRAGMA
 * set, and return a typed Kysely handle. Callers are responsible
 * for running migrations (`migrateToLatest`) before issuing
 * queries against domain tables.
 */
export function openDatabase(options: OpenDatabaseOptions): MementoDatabase {
  const raw = new Database(options.path, {
    readonly: options.readonly === true,
  });

  applyPragmas(raw, {
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    readonly: options.readonly === true,
    inMemory: options.path === ':memory:',
  });

  const db = new Kysely<MementoSchema>({
    dialect: new SqliteDialect({ database: raw }),
  });

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    // Close the raw better-sqlite3 connection synchronously so the
    // OS file handle is released before this function returns.
    // Kysely's `destroy()` is async and only delegates to this same
    // connection through the dialect; calling `raw.close()` here
    // makes the close fully synchronous, which matters on Windows
    // where the file mapping is otherwise held until the next
    // microtask drain.
    raw.close();
  };

  return { raw, db, close };
}

interface PragmaContext {
  readonly busyTimeoutMs: number;
  readonly readonly: boolean;
  readonly inMemory: boolean;
}

/**
 * Apply the canonical PRAGMA set. Centralised so every code path
 * (production open, migrations, tests) gets the same configuration.
 *
 * Notes on each pragma:
 * - `journal_mode = WAL`: concurrent readers + single writer; the
 *   right default for Memento's workload. Skipped for `:memory:`
 *   where WAL is not applicable.
 * - `synchronous = NORMAL`: WAL-safe and substantially faster than
 *   FULL; acceptable since writes are small and journaled.
 * - `foreign_keys = ON`: enforces the FK constraints our schema
 *   declares (memory_events.memory_id, conflicts.*_memory_id, ...).
 *   SQLite leaves this OFF by default — easy footgun.
 * - `busy_timeout`: configurable; see option docs above.
 * - `temp_store = MEMORY`: avoids touching the filesystem for
 *   sort/group temporaries.
 */
function applyPragmas(raw: BetterSqlite3Database, ctx: PragmaContext): void {
  if (!ctx.readonly && !ctx.inMemory) {
    raw.pragma('journal_mode = WAL');
  }
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma(`busy_timeout = ${ctx.busyTimeoutMs}`);
  raw.pragma('temp_store = MEMORY');
}
