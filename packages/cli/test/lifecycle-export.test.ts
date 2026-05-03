// `memento export` lifecycle command tests.
//
// Pure: drives `runExport` against a real on-disk DB seeded via
// `MemoryRepository.write` and asserts the rendered shape (counts,
// schemaVersion, sha256, outPath). Exercises both stdout and file
// sinks plus argv error paths.

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
  const dir = await mkdtemp(join(tmpdir(), 'memento-cli-export-'));
  dirs.push(dir);
  return join(dir, 'memento.db');
}

const NULL_DEPS: LifecycleDeps = {
  createApp: async () => {
    throw new Error('createApp should not be called from runExport');
  },
  migrateStore: async () => {
    throw new Error('migrateStore should not be called from runExport');
  },
  serveStdio: async () => {
    throw new Error('serveStdio should not be called from runExport');
  },
};

function captureIO(): { io: CliIO; stdout: string[] } {
  const stdout: string[] = [];
  const io: CliIO = {
    argv: [],
    env: {},
    stdin: process.stdin,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    },
    stderr: { write: () => true },
    isTTY: false,
    isStderrTTY: false,
    exit: ((code: number): never => {
      throw new Error(`unexpected exit ${code}`);
    }) as CliIO['exit'],
  };
  return { io, stdout };
}

const cliEnv = (overrides: Partial<CliEnv> = {}): CliEnv => ({
  dbPath: ':memory:',
  format: 'json',
  debug: false,
  ...overrides,
});

async function seedDb(path: string): Promise<void> {
  const handle = openDatabase({ path });
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
        content: 'hello world',
        summary: null,
        storedConfidence: 0.9,
      },
      { actor: { type: 'cli' } },
    );
  } finally {
    handle.close();
  }
}

describe('runExport', () => {
  it('writes a memento-export/v1 artefact to the configured --out path', async () => {
    const dbPath = await tmpDb();
    await seedDb(dbPath);
    const outPath = `${dbPath}.jsonl`;

    const { io } = captureIO();
    const result = await runExport(NULL_DEPS, {
      env: cliEnv({ dbPath }),
      subargs: ['--out', outPath],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outPath).toBe(outPath);
    expect(result.value.format).toBe('memento-export/v1');
    expect(result.value.counts.memories).toBe(1);
    expect(result.value.sha256).toMatch(/^[0-9a-f]{64}$/);

    const contents = await readFile(outPath, 'utf8');
    const lines = contents.split('\n').filter((l) => l !== '');
    // header + memory + memory_event(created) + footer = 4 lines.
    expect(lines).toHaveLength(4);
    const header = JSON.parse(lines[0]!);
    expect(header).toMatchObject({ type: 'header', format: 'memento-export/v1' });
    const footer = JSON.parse(lines[lines.length - 1]!);
    expect(footer).toMatchObject({ type: 'footer' });
    expect(footer.sha256).toBe(result.value.sha256);
  });

  it('writes the artefact to stdout when --out is omitted', async () => {
    const dbPath = await tmpDb();
    await seedDb(dbPath);

    const { io, stdout } = captureIO();
    const result = await runExport(NULL_DEPS, {
      env: cliEnv({ dbPath }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outPath).toBeNull();
    const joined = stdout.join('');
    const lines = joined.split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(lines[0]!).type).toBe('header');
    expect(JSON.parse(lines[lines.length - 1]!).type).toBe('footer');
  });

  it('returns STORAGE_ERROR when the database does not exist', async () => {
    const { io } = captureIO();
    const result = await runExport(NULL_DEPS, {
      env: cliEnv({ dbPath: '/no/such/memento.db' }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.message).toContain('/no/such/memento.db');
  });

  it('returns INVALID_INPUT when --out is missing its value', async () => {
    const dbPath = await tmpDb();
    await seedDb(dbPath);
    const { io } = captureIO();
    const result = await runExport(NULL_DEPS, {
      env: cliEnv({ dbPath }),
      subargs: ['--out'],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT on an unknown argument', async () => {
    const dbPath = await tmpDb();
    await seedDb(dbPath);
    const { io } = captureIO();
    const result = await runExport(NULL_DEPS, {
      env: cliEnv({ dbPath }),
      subargs: ['--bogus'],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('reports counts.embeddings === 0 by default and >0 with --include-embeddings', async () => {
    const dbPath = await tmpDb();
    const handle = openDatabase({ path: dbPath });
    try {
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db);
      const memory = await repo.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'tester' },
          kind: { type: 'fact' },
          tags: [],
          pinned: false,
          content: 'x',
          summary: null,
          storedConfidence: 0.9,
        },
        { actor: { type: 'cli' } },
      );
      await repo.setEmbedding(
        memory.id,
        { model: 'bge-small-en-v1.5', dimension: 2, vector: [0.1, 0.2] },
        { actor: { type: 'cli' } },
      );
    } finally {
      handle.close();
    }

    const { io: io1 } = captureIO();
    const without = await runExport(NULL_DEPS, {
      env: cliEnv({ dbPath }),
      subargs: [],
      io: io1,
    });
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.value.counts.embeddings).toBe(0);

    const { io: io2 } = captureIO();
    const withEmb = await runExport(NULL_DEPS, {
      env: cliEnv({ dbPath }),
      subargs: ['--include-embeddings'],
      io: io2,
    });
    expect(withEmb.ok).toBe(true);
    if (!withEmb.ok) return;
    expect(withEmb.value.counts.embeddings).toBe(1);
  });

  // Phase 4 hardening: refuse-to-clobber by default + restrictive
  // file mode. Memory content is operator-private even after
  // scrubbing; an inadvertent --out path that lands on an existing
  // backup must not silently replace it.
  describe('overwrite protection', () => {
    it('returns INVALID_INPUT when the destination already exists and --overwrite is absent', async () => {
      const dbPath = await tmpDb();
      await seedDb(dbPath);
      const outPath = `${dbPath}.jsonl`;
      // Pre-populate the destination.
      await writeFile(outPath, 'pre-existing\n', 'utf8');

      const { io } = captureIO();
      const result = await runExport(NULL_DEPS, {
        env: cliEnv({ dbPath }),
        subargs: ['--out', outPath],
        io,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/refusing to overwrite/u);
      expect(result.error.message).toMatch(/--overwrite/u);
      // Pre-existing content is intact.
      const preserved = await readFile(outPath, 'utf8');
      expect(preserved).toBe('pre-existing\n');
    });

    it('overwrites the destination when --overwrite is set', async () => {
      const dbPath = await tmpDb();
      await seedDb(dbPath);
      const outPath = `${dbPath}.jsonl`;
      await writeFile(outPath, 'pre-existing\n', 'utf8');

      const { io } = captureIO();
      const result = await runExport(NULL_DEPS, {
        env: cliEnv({ dbPath }),
        subargs: ['--out', outPath, '--overwrite'],
        io,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.outPath).toBe(outPath);
      const replaced = await readFile(outPath, 'utf8');
      expect(replaced).not.toBe('pre-existing\n');
      expect(replaced).toMatch(/"type":"header"/);
    });

    it('creates the export file with mode 0o600', async () => {
      // POSIX-only invariant. Windows ACL semantics differ; skip
      // there rather than assert a meaningless permission bitmask.
      if (process.platform === 'win32') return;
      const dbPath = await tmpDb();
      await seedDb(dbPath);
      const outPath = `${dbPath}.jsonl`;
      const { io } = captureIO();
      const result = await runExport(NULL_DEPS, {
        env: cliEnv({ dbPath }),
        subargs: ['--out', outPath],
        io,
      });
      expect(result.ok).toBe(true);
      const { stat } = await import('node:fs/promises');
      const info = await stat(outPath);
      // eslint-disable-next-line no-bitwise
      expect(info.mode & 0o777).toBe(0o600);
    });
  });
});
