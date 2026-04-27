// `memento import` lifecycle command tests.
//
// Drives `runImport` against a real on-disk DB target. Source
// artefacts are produced by `runExport` (round-trip path) or
// hand-crafted (validation paths).

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIGRATIONS,
  createMemoryRepository,
  migrateToLatest,
  openDatabase,
} from '@psraghuveer/memento-core';
import { afterEach, describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runExport } from '../src/lifecycle/export.js';
import { runImport } from '../src/lifecycle/import.js';
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
  const dir = await mkdtemp(join(tmpdir(), 'memento-cli-import-'));
  dirs.push(dir);
  return dir;
}

const NULL_DEPS: LifecycleDeps = {
  createApp: async () => {
    throw new Error('createApp should not be called from runImport');
  },
  migrateStore: async () => {
    throw new Error('migrateStore should not be called from runImport');
  },
  serveStdio: async () => {
    throw new Error('serveStdio should not be called from runImport');
  },
};

const NULL_IO: CliIO = {
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

const cliEnv = (overrides: Partial<CliEnv> = {}): CliEnv => ({
  dbPath: ':memory:',
  format: 'json',
  debug: false,
  ...overrides,
});

async function seed(dbPath: string): Promise<void> {
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
        content: 'hello',
        summary: null,
        storedConfidence: 0.9,
      },
      { actor: { type: 'cli' } },
    );
  } finally {
    handle.close();
  }
}

async function emptyMigrated(dbPath: string): Promise<void> {
  const handle = openDatabase({ path: dbPath });
  try {
    await migrateToLatest(handle.db, MIGRATIONS);
  } finally {
    handle.close();
  }
}

async function makeArtefact(): Promise<{ artefact: string; sourceDb: string }> {
  const dir = await tmpDir();
  const sourceDb = join(dir, 'source.db');
  const artefact = join(dir, 'artefact.jsonl');
  await seed(sourceDb);
  const result = await runExport(NULL_DEPS, {
    env: cliEnv({ dbPath: sourceDb }),
    subargs: ['--out', artefact],
    io: NULL_IO,
  });
  if (!result.ok) throw new Error('export failed during fixture setup');
  return { artefact, sourceDb };
}

describe('runImport', () => {
  it('rejects missing --in', async () => {
    const result = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: ':memory:' }),
      subargs: [],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('--in');
  });

  it('rejects --on-conflict with an unknown value', async () => {
    const result = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: ':memory:' }),
      subargs: ['--in', '/dev/null', '--on-conflict', 'merge'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns STORAGE_ERROR when the artefact does not exist', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'target.db');
    await emptyMigrated(dbPath);
    const result = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath }),
      subargs: ['--in', join(dir, 'no-such.jsonl')],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
  });

  it('round-trips an artefact into a fresh DB (counts match)', async () => {
    const { artefact } = await makeArtefact();
    const dir = await tmpDir();
    const targetDb = join(dir, 'target.db');
    await emptyMigrated(targetDb);

    const result = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: targetDb }),
      subargs: ['--in', artefact],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied.memories).toBe(1);
    expect(result.value.dryRun).toBe(false);

    const handle = openDatabase({ path: targetDb });
    try {
      const count = handle.raw.prepare('select count(*) as n from memories').get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('--dry-run reports counts without writing to the target DB', async () => {
    const { artefact } = await makeArtefact();
    const dir = await tmpDir();
    const targetDb = join(dir, 'target.db');
    await emptyMigrated(targetDb);

    const result = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: targetDb }),
      subargs: ['--in', artefact, '--dry-run'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(result.value.applied.memories).toBe(1);

    const handle = openDatabase({ path: targetDb });
    try {
      const count = handle.raw.prepare('select count(*) as n from memories').get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      handle.close();
    }
  });

  it("--on-conflict='skip' is idempotent on re-import", async () => {
    const { artefact } = await makeArtefact();
    const dir = await tmpDir();
    const targetDb = join(dir, 'target.db');
    await emptyMigrated(targetDb);

    const first = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: targetDb }),
      subargs: ['--in', artefact, '--on-conflict', 'skip'],
      io: NULL_IO,
    });
    expect(first.ok).toBe(true);
    const second = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: targetDb }),
      subargs: ['--in', artefact, '--on-conflict', 'skip'],
      io: NULL_IO,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.skipped.memories).toBe(1);
  });

  it("--on-conflict='abort' returns CONFLICT on re-import", async () => {
    const { artefact } = await makeArtefact();
    const dir = await tmpDir();
    const targetDb = join(dir, 'target.db');
    await emptyMigrated(targetDb);

    await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: targetDb }),
      subargs: ['--in', artefact, '--on-conflict', 'abort'],
      io: NULL_IO,
    });
    const second = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: targetDb }),
      subargs: ['--in', artefact, '--on-conflict', 'abort'],
      io: NULL_IO,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('CONFLICT');
  });

  it('rejects a corrupted artefact (sha256 mismatch) with INVALID_INPUT', async () => {
    const { artefact } = await makeArtefact();
    const raw = await readFile(artefact, 'utf8');
    const lines = raw.split('\n').filter((l) => l !== '');
    // Mutate the memory line's content while leaving the footer intact.
    const tampered = lines[1]!.replace('hello', 'goodbye');
    expect(tampered).not.toBe(lines[1]);
    const corrupt = `${[lines[0], tampered, ...lines.slice(2)].join('\n')}\n`;
    const corruptPath = artefact.replace(/\.jsonl$/, '.corrupt.jsonl');
    await writeFile(corruptPath, corrupt, 'utf8');

    const dir = await tmpDir();
    const targetDb = join(dir, 'target.db');
    await emptyMigrated(targetDb);
    const result = await runImport(NULL_DEPS, {
      env: cliEnv({ dbPath: targetDb }),
      subargs: ['--in', corruptPath],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});
