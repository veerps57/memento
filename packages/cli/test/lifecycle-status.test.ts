// `memento status` lifecycle command tests.
//
// Drives `runStatus` against a real on-disk DB and asserts
// the returned snapshot contains expected counts and metadata.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CreateMementoAppOptions,
  MIGRATIONS,
  createMementoApp,
  createMemoryRepository,
  migrateToLatest,
  openDatabase,
} from '@psraghuveer/memento-core';
import { afterEach, describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runStatus } from '../src/lifecycle/status.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';
import { rmTmp } from './_helpers/rm-tmp.js';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) await rmTmp(d);
  }
});

async function tmpDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memento-cli-status-'));
  dirs.push(dir);
  return join(dir, 'memento.db');
}

const createAppNoVector: typeof createMementoApp = (opts: CreateMementoAppOptions) =>
  createMementoApp({
    ...opts,
    configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
  });

function makeDeps(): LifecycleDeps {
  return {
    createApp: createAppNoVector,
    migrateStore: async () => {
      throw new Error('migrateStore should not be called from runStatus');
    },
    serveStdio: async () => {
      throw new Error('serveStdio should not be called from runStatus');
    },
  };
}

function captureIO(): { io: CliIO } {
  const io: CliIO = {
    argv: [],
    env: {},
    stdin: process.stdin,
    stdout: { write: () => true },
    stderr: { write: () => true },
    isTTY: false,
    isStderrTTY: false,
    exit: ((code: number): never => {
      throw new Error(`unexpected exit ${code}`);
    }) as CliIO['exit'],
  };
  return { io };
}

const cliEnv = (overrides: Partial<CliEnv> = {}): CliEnv => ({
  dbPath: ':memory:',
  format: 'json',
  debug: false,
  ...overrides,
});

async function seedDb(path: string, count = 1): Promise<void> {
  const handle = openDatabase({ path });
  try {
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db);
    for (let i = 0; i < count; i++) {
      await repo.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'tester' },
          kind: { type: 'fact' },
          tags: [],
          pinned: false,
          content: `memory ${i}`,
          summary: null,
          storedConfidence: 0.9,
        },
        { actor: { type: 'cli' } },
      );
    }
  } finally {
    handle.close();
  }
}

describe('runStatus', () => {
  it('returns a snapshot with memory counts for a seeded database', async () => {
    const dbPath = await tmpDb();
    await seedDb(dbPath, 3);

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runStatus(deps, {
      env: cliEnv({ dbPath }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memoryCount).toBe(3);
    expect(result.value.dbPath).toBe(dbPath);
    expect(result.value.dbBytes).toBeGreaterThan(0);
    expect(result.value.version).toBeDefined();
    expect(result.value.conflictCount).toBe(0);
    expect(result.value.vectorEnabled).toBe(false);
  });

  it('returns memoryByKind breakdown', async () => {
    const dbPath = await tmpDb();
    await seedDb(dbPath, 2);

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runStatus(deps, {
      env: cliEnv({ dbPath }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
    expect(result.value.memoryByKind['fact']).toBe(2);
  });

  it('returns lastEventAt as an ISO string when events exist', async () => {
    const dbPath = await tmpDb();
    await seedDb(dbPath, 1);

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runStatus(deps, {
      env: cliEnv({ dbPath }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lastEventAt).not.toBeNull();
    // Should be a valid ISO date string
    expect(new Date(result.value.lastEventAt as string).toISOString()).toBe(
      result.value.lastEventAt,
    );
  });

  it('returns zeros for an empty database', async () => {
    const dbPath = await tmpDb();
    // Seed with 0 memories — just create the schema.
    await seedDb(dbPath, 0);

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runStatus(deps, {
      env: cliEnv({ dbPath }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memoryCount).toBe(0);
    expect(result.value.conflictCount).toBe(0);
    expect(result.value.lastEventAt).toBeNull();
  });

  it('returns STORAGE_ERROR when the database path does not exist', async () => {
    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runStatus(deps, {
      env: cliEnv({ dbPath: '/no/such/path/memento.db' }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
  });

  it('returns null dbBytes for an in-memory database', async () => {
    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runStatus(deps, {
      env: cliEnv({ dbPath: ':memory:' }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dbBytes).toBeNull();
    expect(result.value.dbPath).toBe(':memory:');
    expect(result.value.memoryCount).toBe(0);
    expect(result.value.lastEventAt).toBeNull();
    expect(result.value.vectorEnabled).toBe(false);
  });
});
