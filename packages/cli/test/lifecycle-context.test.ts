// `memento context` lifecycle command — exercised against a real
// `createMementoApp(':memory:')` so the snapshot reflects the
// production registry exactly. The cost is a single SQLite
// migration per test; the gain is a contract test that catches
// drift between command registration in `@psraghuveer/memento-core` and
// what the CLI advertises.

import { type CreateMementoAppOptions, createMementoApp } from '@psraghuveer/memento-core';
import { CONFIG_KEY_NAMES } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runContext } from '../src/lifecycle/context.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';

const createAppNoVector: typeof createMementoApp = (opts: CreateMementoAppOptions) =>
  createMementoApp({
    ...opts,
    configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
  });

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

/** Migrations are exercised by store-migrate tests, not these. */
const rejectMigrateStore: LifecycleDeps['migrateStore'] = async () => {
  throw new Error('migrateStore should not be called from runContext');
};

/** Serve is exercised by serve tests, not these. */
const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called from runContext');
};

describe('runContext', () => {
  it('returns a snapshot with version, dbPath, registry, and config', async () => {
    const result = await runContext(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snap = result.value;
    expect(typeof snap.version).toBe('string');
    expect(snap.version.length).toBeGreaterThan(0);
    expect(snap.dbPath).toBe(':memory:');
    expect(snap.registry.commands.length).toBeGreaterThan(0);
    for (const cmd of snap.registry.commands) {
      expect(cmd.name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/i);
      expect(typeof cmd.description).toBe('string');
      expect(cmd.surfaces.length).toBeGreaterThan(0);
    }
    // Snapshot covers every config key.
    expect(Object.keys(snap.config).sort()).toEqual([...CONFIG_KEY_NAMES].sort());
  });

  it('surfaces a STORAGE_ERROR when createApp throws', async () => {
    const result = await runContext(
      {
        createApp: async () => {
          throw new Error('disk on fire');
        },
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: '/no/such/path.db' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.message).toContain('/no/such/path.db');
    expect(result.error.message).toContain('disk on fire');
  });

  it('closes the app even when the snapshot succeeds', async () => {
    let closed = false;
    const real = await createAppNoVector({ dbPath: ':memory:' });
    const result = await runContext(
      {
        createApp: async () => ({
          ...real,
          close: () => {
            closed = true;
            real.close();
          },
        }),
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    expect(closed).toBe(true);
  });
});
