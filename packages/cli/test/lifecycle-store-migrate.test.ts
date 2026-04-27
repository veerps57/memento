// `memento store migrate` lifecycle command tests.
//
// Two-layer coverage:
//
//   - Pure: drive `runStoreMigrate` with a fake `migrateStore`.
//     Asserts the rendered shape (counts, dbPath, ordered list)
//     and the STORAGE_ERROR path on a thrown migration.
//
//   - Real: drive the default migration runner against a fresh
//     `:memory:` database and assert that the second invocation
//     reports every migration as `skipped` (idempotency).

import {
  MIGRATIONS,
  type MigrationOutcome,
  migrateToLatest,
  openDatabase,
} from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runStoreMigrate } from '../src/lifecycle/store-migrate.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';

const NULL_IO: CliIO = {
  argv: [],
  env: {},
  stdin: process.stdin,
  stdout: { write: () => undefined },
  stderr: { write: () => undefined },
  isTTY: false,
  isStderrTTY: false,
  exit: ((code: number): never => {
    throw new Error(`unexpected exit ${code}`);
  }) as CliIO['exit'],
};

const cliEnv = (overrides: Partial<CliEnv> = {}): CliEnv => ({
  dbPath: ':memory:',
  format: 'json',
  debug: false,
  ...overrides,
});

const rejectCreateApp: LifecycleDeps['createApp'] = async () => {
  throw new Error('createApp should not be called from runStoreMigrate');
};

const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called from runStoreMigrate');
};

describe('runStoreMigrate (pure, fake migrateStore)', () => {
  it('counts applied vs skipped and preserves order', async () => {
    const outcomes: readonly MigrationOutcome[] = [
      { name: '0001_init', status: 'skipped' },
      { name: '0002_events', status: 'applied' },
      { name: '0003_conflicts', status: 'applied' },
    ];
    const result = await runStoreMigrate(
      {
        createApp: rejectCreateApp,
        migrateStore: async () => outcomes,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: '/tmp/mem.db' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dbPath).toBe('/tmp/mem.db');
    expect(result.value.applied).toBe(2);
    expect(result.value.skipped).toBe(1);
    expect(result.value.migrations.map((m) => m.name)).toEqual([
      '0001_init',
      '0002_events',
      '0003_conflicts',
    ]);
  });

  it('returns STORAGE_ERROR when migrateStore throws', async () => {
    const result = await runStoreMigrate(
      {
        createApp: rejectCreateApp,
        migrateStore: async () => {
          throw new Error('locked');
        },
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: '/no/such.db' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.message).toContain('/no/such.db');
    expect(result.error.message).toContain('locked');
  });
});

describe('runStoreMigrate (real, in-memory DB)', () => {
  it('applies every migration on first run and skips them on the second', async () => {
    const handle = openDatabase({ path: ':memory:' });
    try {
      // First run: every migration is `applied`.
      const first = await migrateToLatest(handle.db, MIGRATIONS);
      expect(first.length).toBe(MIGRATIONS.length);
      expect(first.every((o) => o.status === 'applied')).toBe(true);
      // Second run: every migration is `skipped`.
      const second = await migrateToLatest(handle.db, MIGRATIONS);
      expect(second.length).toBe(MIGRATIONS.length);
      expect(second.every((o) => o.status === 'skipped')).toBe(true);
    } finally {
      handle.close();
    }
  });
});
