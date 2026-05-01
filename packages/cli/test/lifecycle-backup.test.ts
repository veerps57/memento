// `memento backup` lifecycle command tests.
//
// Drives `runBackup` against a real on-disk DB and asserts
// the VACUUM INTO operation produces a valid backup file.

import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIGRATIONS,
  createMementoApp,
  createMemoryRepository,
  migrateToLatest,
  openDatabase,
} from '@psraghuveer/memento-core';
import { afterEach, describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runBackup } from '../src/lifecycle/backup.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';
import { rmTmp } from './_helpers/rm-tmp.js';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) await rmTmp(d);
  }
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memento-cli-backup-'));
  dirs.push(dir);
  return dir;
}

const createAppNoVector: typeof createMementoApp = (opts) =>
  createMementoApp({
    ...opts,
    configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
  });

function makeDeps(): LifecycleDeps {
  return {
    createApp: createAppNoVector,
    migrateStore: async () => {
      throw new Error('migrateStore should not be called from runBackup');
    },
    serveStdio: async () => {
      throw new Error('serveStdio should not be called from runBackup');
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

async function seedDb(dbPath: string): Promise<void> {
  const handle = openDatabase({ path: dbPath });
  try {
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db);
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'tester' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'backup test memory',
        summary: null,
        storedConfidence: 0.9,
      },
      { actor: { type: 'cli' } },
    );
  } finally {
    handle.close();
  }
}

describe('runBackup', () => {
  it('creates a backup file at the specified destination', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'backup.db');

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [destPath],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe(dbPath);
    expect(result.value.destination).toBe(destPath);
    expect(result.value.bytes).toBeGreaterThan(0);
    expect(result.value.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(existsSync(destPath)).toBe(true);
  });

  it('supports --out flag for destination', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'out-backup.db');

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: ['--out', destPath],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.destination).toBe(destPath);
    expect(existsSync(destPath)).toBe(true);
  });

  it('supports --out= syntax for destination', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'eq-backup.db');

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [`--out=${destPath}`],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.destination).toBe(destPath);
  });

  it('returns INVALID_INPUT when no destination is provided', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('destination path');
  });

  it('returns INVALID_INPUT for :memory: databases', async () => {
    const dir = await tmpDir();
    const destPath = join(dir, 'backup.db');

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath: ':memory:' }),
      subargs: [destPath],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain(':memory:');
  });

  it('refuses to overwrite an existing file without --force', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'existing.db');
    writeFileSync(destPath, 'existing content');

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [destPath],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('already exists');
    expect(result.error.message).toContain('--force');
  });

  it('overwrites an existing backup when --force is set', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'existing.db');

    // Create a first backup so the destination is a real SQLite file.
    const deps = makeDeps();
    const { io } = captureIO();
    const first = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [destPath],
      io,
    });
    expect(first.ok).toBe(true);
    expect(existsSync(destPath)).toBe(true);

    // Overwrite with --force.
    const { io: io2 } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: ['--force', destPath],
      io: io2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytes).toBeGreaterThan(0);
  });

  it('supports -f shorthand for --force', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'existing2.db');

    // Create a first backup.
    const deps = makeDeps();
    const { io } = captureIO();
    await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [destPath],
      io,
    });

    // Overwrite with -f.
    const { io: io2 } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: ['-f', destPath],
      io: io2,
    });
    expect(result.ok).toBe(true);
  });

  it('returns INVALID_INPUT for unknown arguments', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: ['--bogus'],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('--bogus');
  });

  it('creates intermediate directories for the destination', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'nested', 'deep', 'backup.db');

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [destPath],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(destPath)).toBe(true);
  });

  it('backup file is a valid SQLite database', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'source.db');
    await seedDb(dbPath);
    const destPath = join(dir, 'valid-backup.db');

    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runBackup(deps, {
      env: cliEnv({ dbPath }),
      subargs: [destPath],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Open the backup and verify it has the expected data.
    const handle = openDatabase({ path: destPath });
    try {
      const row = handle.raw.prepare('select count(*) as n from memories').get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      handle.close();
    }
  });
});
