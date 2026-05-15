// `memento doctor` lifecycle command.
//
// Each check is exercised independently so the test suite
// pins the contract of every reported `name`. The "happy
// path" runs against a real `createMementoApp(':memory:')`
// to assert the command does not regress when the engine is
// healthy; failure paths use injected fakes.

import { type CreateMementoAppOptions, createMementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runDoctor } from '../src/lifecycle/doctor.js';
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
          shutdown: async () => {
            closed = true;
            await real.shutdown();
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

  it('--quick skips database and embedder checks', async () => {
    const result = await runDoctor(
      {
        createApp: async () => {
          throw new Error('should not be called with --quick');
        },
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: ['--quick'], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.checks.map((c) => c.name);
    // --quick only runs cheap host checks: node-version, db-path-writable, native-binding.
    expect(names).not.toContain('database');
    expect(names).not.toContain('embedder');
    expect(names).toContain('node-version');
  });

  it('--mcp includes MCP client config checks', async () => {
    const result = await runDoctor(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: ['--mcp'], io: NULL_IO },
    );
    expect(result.ok === true || result.ok === false).toBe(true);
    // The key assertion: when --mcp is passed, at least one
    // `mcp-` prefixed check appears in the list.
    if (result.ok) {
      const mcpChecks = result.value.checks.filter((c) => c.name.startsWith('mcp-'));
      expect(mcpChecks.length).toBeGreaterThan(0);
    } else {
      const details = result.error.details as { checks: Array<{ name: string }> };
      const mcpChecks = details.checks.filter((c) => c.name.startsWith('mcp-'));
      expect(mcpChecks.length).toBeGreaterThan(0);
    }
  });

  it('returns INVALID_INPUT for unknown arguments', async () => {
    const result = await runDoctor(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: ['--bogus'], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('--bogus');
  });

  it('reports db-path-writable success for a real writable directory', async () => {
    // Use a tmpdir-based path so `checkDbPathWritable` exercises the
    // `access(dir, W_OK)` success branch (lines 201-205) rather than
    // the `:memory:` early-return or the catch block.
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'memento-doctor-'));
    const dbPath = join(dir, 'test.db');
    try {
      const result = await runDoctor(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        { env: cliEnv({ dbPath }), subargs: [], io: NULL_IO },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const pathCheck = result.value.checks.find((c) => c.name === 'db-path-writable');
      expect(pathCheck?.ok).toBe(true);
      expect(pathCheck?.message).toContain('is writable');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses String(cause) in error messages when createApp throws a non-Error value', async () => {
    const result = await runDoctor(
      {
        createApp: async () => {
          // Throw a non-Error object to exercise the String(cause) fallback in describe().
          throw Object.assign(Object.create(null), { toString: () => 'plain string failure' });
        },
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: ':memory:' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    const details = result.error.details as {
      checks: Array<{ name: string; ok: boolean; message: string }>;
    };
    const dbCheck = details.checks.find((c) => c.name === 'database');
    expect(dbCheck?.ok).toBe(false);
    expect(dbCheck?.message).toContain('plain string failure');
  });

  it('--mcp checks report file-not-present for missing config files', async () => {
    // The MCP scan should include at least one mcp- check, and
    // most entries will be "not present (skipped)" on CI hosts
    // without assistant config files. Assert that shape.
    const result = await runDoctor(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: ['--mcp'], io: NULL_IO },
    );
    // Whether overall ok depends on filesystem; we only care about
    // the mcp- check structure.
    const checks =
      result.ok === true
        ? result.value.checks
        : (
            result.error.details as {
              checks: Array<{ name: string; ok: boolean; message: string }>;
            }
          ).checks;
    const mcpChecks = checks.filter((c) => c.name.startsWith('mcp-'));
    expect(mcpChecks.length).toBeGreaterThanOrEqual(6);
    // Every mcp- check should have a string message.
    for (const c of mcpChecks) {
      expect(typeof c.message).toBe('string');
      expect(c.message.length).toBeGreaterThan(0);
    }
  });

  it('embedder check reports ok when vector is disabled', async () => {
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
    const embedCheck = result.value.checks.find((c) => c.name === 'embedder');
    expect(embedCheck?.ok).toBe(true);
    expect(embedCheck?.message).toContain('vector.enabled is false');
  });
});
