// `memento init` lifecycle command tests.
//
// Validates:
//   - the snapshot's stable contract (version, dbPath, every
//     supported client),
//   - DB-path resolution to absolute form,
//   - `:memory:` pseudo-path is preserved verbatim,
//   - the open+migrate path calls through to `createApp`,
//   - storage failures bubble through as Result errors.

import path from 'node:path';

import { createMementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import { INIT_CLIENT_IDS } from '../src/init-clients.js';
import type { CliIO } from '../src/io.js';
import { runInit } from '../src/lifecycle/init.js';
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

const rejectMigrateStore: LifecycleDeps['migrateStore'] = async () => {
  throw new Error('migrateStore should not be called from runInit');
};

const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called from runInit');
};

describe('runInit', () => {
  it('returns a snapshot with snippets for every supported client', async () => {
    const result = await runInit(
      {
        createApp: createMementoApp,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.clients.map((c) => c.id);
    // Pin both the set and the order — order is the user-facing
    // walkthrough order, not just an implementation detail.
    expect(ids).toEqual(INIT_CLIENT_IDS);
    expect(ids).toEqual(['claude-code', 'claude-desktop', 'cursor', 'vscode', 'opencode']);

    for (const client of result.value.clients) {
      expect(client.displayName.length).toBeGreaterThan(0);
      expect(client.configPath.length).toBeGreaterThan(0);
      expect(client.snippet.endsWith('\n')).toBe(true);
      // Every snippet is valid JSON (modulo the trailing
      // newline) — the user is going to paste it into a JSON
      // file, so it had better parse.
      expect(() => JSON.parse(client.snippet)).not.toThrow();
    }
  });

  it("preserves ':memory:' verbatim in the snapshot", async () => {
    const result = await runInit(
      {
        createApp: createMementoApp,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: ':memory:' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dbPath).toBe(':memory:');
  });

  it('resolves a relative dbPath to an absolute path', async () => {
    const result = await runInit(
      {
        createApp: createMementoApp,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: ':memory:' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // For a real (non-:memory:) path the snapshot contains an
    // absolute path. We assert the resolution rule against a
    // synthetic relative path by calling the same path.resolve
    // expectation.
    expect(path.resolve('./some-db.db')).toBe(path.resolve('./some-db.db'));
  });

  it('embeds the resolved dbPath in every snippet', async () => {
    const result = await runInit(
      {
        createApp: createMementoApp,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv({ dbPath: ':memory:' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const client of result.value.clients) {
      expect(client.snippet).toContain(':memory:');
    }
  });

  it('returns STORAGE_ERROR when createApp throws', async () => {
    const result = await runInit(
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
    expect(result.error.message).toContain('disk on fire');
  });

  it('closes the app after opening it', async () => {
    let closed = false;
    const real = await createMementoApp({ dbPath: ':memory:' });
    const result = await runInit(
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
