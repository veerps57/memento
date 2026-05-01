// `memento doctor` lifecycle command.
//
// Each check is exercised independently so the test suite
// pins the contract of every reported `name`. The "happy
// path" runs against a real `createMementoApp(':memory:')`
// to assert the command does not regress when the engine is
// healthy; failure paths use injected fakes.

import { createMementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runDoctor } from '../src/lifecycle/doctor.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';

const createAppNoVector: typeof createMementoApp = (opts) =>
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

const rejectMigrateStore: LifecycleDeps['migrateStore'] = async () => {
  throw new Error('migrateStore should not be called from runDoctor');
};

const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called from runDoctor');
};

describe('runDoctor', () => {
  it('returns ok with every check green for a healthy install', async () => {
    const result = await runDoctor(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ok).toBe(true);
    const names = result.value.checks.map((c) => c.name);
    expect(names).toEqual([
      'node-version',
      'db-path-writable',
      'native-binding',
      'database',
      'embedder',
    ]);
    for (const c of result.value.checks) {
      expect(c.ok).toBe(true);
      expect(typeof c.message).toBe('string');
    }
  });

  it('reports STORAGE_ERROR when the database fails to open', async () => {
    const result = await runDoctor(
      {
        createApp: async () => {
          throw new Error('disk on fire');
        },
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: ':memory:' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.message).toContain('database');
    const details = result.error.details as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; message: string }>;
    };
    expect(details.ok).toBe(false);
    const dbCheck = details.checks.find((c) => c.name === 'database');
    expect(dbCheck?.ok).toBe(false);
    expect(dbCheck?.message).toContain('disk on fire');
  });

  it('reports STORAGE_ERROR when the db parent directory is not writable', async () => {
    // `/no/such/path/here.db` has parent `/no/such/path` which
    // does not exist on any sane CI host. This exercises the
    // pre-create check; createApp also fails and is reported
    // separately, but only one db-class failure is needed to
    // tip the aggregate code to STORAGE_ERROR.
    const result = await runDoctor(
      {
        createApp: async () => {
          throw new Error('cannot open');
        },
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      {
        env: cliEnv({ dbPath: '/no/such/path/here.db' }),
        subargs: [],
        io: NULL_IO,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    const details = result.error.details as { checks: Array<{ name: string; ok: boolean }> };
    const pathCheck = details.checks.find((c) => c.name === 'db-path-writable');
    expect(pathCheck?.ok).toBe(false);
  });

  it('closes the app even when checks succeed', async () => {
    let closed = false;
    const real = await createAppNoVector({ dbPath: ':memory:' });
    const result = await runDoctor(
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
