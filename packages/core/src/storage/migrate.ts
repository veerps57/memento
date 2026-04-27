// Migration runner.
//
// We sidestep Kysely's `FileMigrationProvider` because our
// migrations are TypeScript modules registered programmatically:
// the registry lives in `migrations/index.ts` and is imported
// directly. This keeps the build pipeline simple (no
// `import.meta.url`-based directory scanning, no special
// handling for the `dist/` layout) and makes the order explicit.
//
// Migrations are append-only. Editing a published migration is a
// review-time rejection: write a new one. The runner keeps a
// `_memento_migrations` table that records `(name, runAt)` for
// every applied migration; `migrateToLatest` is idempotent.

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { MIGRATIONS } from './migrations/index.js';
import type { MementoSchema } from './schema.js';

/**
 * Outcome record for a single migration in a {@link migrateToLatest}
 * run. `status` is `applied` for migrations executed in this call,
 * `skipped` for ones already present in the bookkeeping table.
 */
export interface MigrationOutcome {
  readonly name: string;
  readonly status: 'applied' | 'skipped';
}

/**
 * Shape of one entry in the migration registry. `up` is required;
 * `down` is optional because v1 ships forward-only — a `down` exists
 * only when a migration is reversible cheaply (most are not).
 */
export interface Migration {
  readonly name: string;
  up(db: Kysely<MementoSchema>): Promise<void>;
  down?(db: Kysely<MementoSchema>): Promise<void>;
}

const BOOKKEEPING_TABLE = '_memento_migrations';

/**
 * Apply every registered migration that has not already been
 * recorded in the bookkeeping table. Returns one
 * {@link MigrationOutcome} per registered migration, in registry
 * order, so callers can render a status line per file.
 *
 * The bookkeeping write happens inside the same transaction as
 * the migration body. If `up` throws, nothing is committed and
 * the migration is retried on the next run.
 *
 * `migrations` defaults to the package-level registry; tests
 * override it to exercise edge cases without mutating shared
 * state.
 */
export async function migrateToLatest(
  db: Kysely<MementoSchema>,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<readonly MigrationOutcome[]> {
  await ensureBookkeepingTable(db);
  const applied = await loadAppliedNames(db);

  // Downgrade guard: if the bookkeeping table records migrations
  // we don't know about, this build is older than the database
  // it's pointed at. Continuing would silently operate on a
  // schema this build can't reason about (extra columns, missing
  // indexes, future tables) — exactly the failure mode P3.4
  // calls out. Fail up front with a single, structured error.
  const known = new Set(migrations.map((m) => m.name));
  const unknown = [...applied].filter((name) => !known.has(name)).sort();
  if (unknown.length > 0) {
    throw new MementoMigrationDowngradeError(unknown);
  }

  const outcomes: MigrationOutcome[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      outcomes.push({ name: migration.name, status: 'skipped' });
      continue;
    }
    await db.transaction().execute(async (tx) => {
      await migration.up(tx);
      await sql`insert into ${sql.table(BOOKKEEPING_TABLE)} (name, run_at) values (${migration.name}, ${new Date().toISOString()})`.execute(
        tx,
      );
    });
    outcomes.push({ name: migration.name, status: 'applied' });
  }

  return outcomes;
}

/**
 * Thrown by {@link migrateToLatest} when the bookkeeping table
 * records migrations the running build does not know about
 * (typically: an older binary opening a database last touched by
 * a newer one). The error carries the unknown migration names so
 * a host can render a helpful "your build is older than this
 * database" message and offer the upgrade path.
 *
 * Code is mapped to `STORAGE_ERROR` by the repo-error mapper.
 */
export class MementoMigrationDowngradeError extends Error {
  readonly code = 'STORAGE_ERROR' as const;
  readonly unknownMigrations: readonly string[];

  constructor(unknownMigrations: readonly string[]) {
    const list = unknownMigrations.join(', ');
    super(
      `Database has migrations this build does not know about: ${list}. This build is older than the database. Upgrade the binary or point at a database created by a build that includes these migrations.`,
    );
    this.name = 'MementoMigrationDowngradeError';
    this.unknownMigrations = unknownMigrations;
  }
}

async function ensureBookkeepingTable(db: Kysely<MementoSchema>): Promise<void> {
  await sql`
    create table if not exists ${sql.table(BOOKKEEPING_TABLE)} (
      name    text primary key,
      run_at  text not null
    )
  `.execute(db);
}

async function loadAppliedNames(db: Kysely<MementoSchema>): Promise<Set<string>> {
  const rows = await sql<{
    name: string;
  }>`select name from ${sql.table(BOOKKEEPING_TABLE)}`.execute(db);
  return new Set(rows.rows.map((r) => r.name));
}
