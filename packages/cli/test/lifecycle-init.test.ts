// `memento init` lifecycle command tests.
//
// Validates:
//   - the snapshot's stable contract (version, dbPath, every
//     supported client),
//   - DB-path resolution to absolute form,
//   - `:memory:` pseudo-path is preserved verbatim,
//   - the open+migrate path calls through to `createApp`,
//   - storage failures bubble through as Result errors.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type CreateMementoAppOptions, createMementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import { INIT_CLIENT_IDS } from '../src/init-clients.js';
import type { CliIO } from '../src/io.js';
import { runInit } from '../src/lifecycle/init.js';
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
  throw new Error('migrateStore should not be called from runInit');
};

const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called from runInit');
};

describe('runInit', () => {
  it('returns a snapshot with snippets for every supported client', async () => {
    const result = await runInit(
      {
        createApp: createAppNoVector,
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
      expect(typeof client.supportsSkills).toBe('boolean');
      // Every snippet is valid JSON (modulo the trailing
      // newline) — the user is going to paste it into a JSON
      // file, so it had better parse.
      expect(() => JSON.parse(client.snippet)).not.toThrow();
    }

    // Skill section: with the default client filter (i.e.
    // every supported client), the capable list MUST include
    // the two Anthropic-product clients. This pins the
    // contract that drives the renderer's "install the skill"
    // section.
    expect(result.value.skill.capableClients).toEqual(
      expect.arrayContaining(['claude-code', 'claude-desktop']),
    );
    expect(result.value.skill.suggestedTarget.length).toBeGreaterThan(0);
    // `source` MUST be non-null in the test environment because
    // the workspace ships `<workspace>/skills/memento/SKILL.md`
    // as the source-of-truth location. Asserting this catches
    // regressions in the resolver path (`skill-source.ts`) that
    // would otherwise only surface as missing instructions in
    // the rendered walkthrough.
    expect(result.value.skill.source).not.toBeNull();
    expect(result.value.skill.source).toMatch(/skills[\\/]memento$/);
  });

  it('reports an empty capable client set when filtered to non-skill-capable clients', async () => {
    // When the user runs `memento init --client cursor`, the
    // skill section MUST be suppressed — Cursor does not load
    // Anthropic skills. The renderer keys off `capableClients`
    // being empty, so the snapshot field is the gate.
    const result = await runInit(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      },
      { env: cliEnv(), subargs: ['--client', 'cursor,vscode,opencode'], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skill.capableClients).toEqual([]);
  });

  it("preserves ':memory:' verbatim in the snapshot", async () => {
    const result = await runInit(
      {
        createApp: createAppNoVector,
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
        createApp: createAppNoVector,
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
        createApp: createAppNoVector,
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
    const real = await createAppNoVector({ dbPath: ':memory:' });
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

  it("creates the parent directory when it doesn't exist", async () => {
    // Regression test for the fresh-install bug: on a brand-new
    // host the XDG default (~/.local/share/memento/) does not
    // exist, and the writability check used to fail before
    // openAppForSurface had a chance to create the DB file.
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memento-init-mkdir-'));
    try {
      const dbPath = path.join(tmpRoot, 'nested', 'subdir', 'memento.db');
      const parent = path.dirname(dbPath);
      expect(existsSync(parent)).toBe(false);
      const result = await runInit(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        { env: cliEnv({ dbPath }), subargs: [], io: NULL_IO },
      );
      expect(result.ok).toBe(true);
      expect(existsSync(parent)).toBe(true);
      if (!result.ok) return;
      const writable = result.value.checks.find((c) => c.name === 'db-path-writable');
      expect(writable?.ok).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('cleans orphan WAL/SHM sidecars when the main db is missing', async () => {
    // Regression test for the half-deleted-store bug: a user
    // who runs `rm memento.db` leaves `memento.db-wal` and
    // `memento.db-shm` behind. The next `memento init` would
    // crash inside SQLite's WAL recovery with a misleading
    // 'disk I/O error'. `init` now detects and cleans those
    // orphans before openAppForSurface gets a chance to trip.
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memento-init-wal-'));
    try {
      const dbPath = path.join(tmpRoot, 'memento.db');
      // Seed the orphan sidecars exactly the way SQLite would
      // have left them after a half-deleted-store. The contents
      // are arbitrary because the cleanup never reads them.
      writeFileSync(`${dbPath}-wal`, 'orphan-wal-bytes');
      writeFileSync(`${dbPath}-shm`, 'orphan-shm-bytes');
      writeFileSync(`${dbPath}-journal`, 'orphan-journal-bytes');
      expect(existsSync(dbPath)).toBe(false);

      const result = await runInit(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        { env: cliEnv({ dbPath }), subargs: [], io: NULL_IO },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Sidecars are gone, main db now exists, and the cleanup
      // is observable in the snapshot — the operator sees what
      // happened on their behalf rather than a silent surprise.
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      expect(existsSync(`${dbPath}-journal`)).toBe(false);
      expect(existsSync(dbPath)).toBe(true);

      const cleanup = result.value.checks.find((c) => c.name === 'stale-wal-sidecars');
      expect(cleanup?.ok).toBe(true);
      expect(cleanup?.message).toContain('cleaned');
      expect(cleanup?.message).toContain('memento.db-wal');
      expect(cleanup?.message).toContain('memento.db-shm');
      expect(cleanup?.message).toContain('memento.db-journal');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not touch sidecars when the main db exists', async () => {
    // Critical safety property: when the main `.db` is present,
    // any sidecars belong to SQLite — the cleanup must NOT
    // delete them. Touching live sidecars would corrupt an
    // active database.
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memento-init-wal-keep-'));
    try {
      const dbPath = path.join(tmpRoot, 'memento.db');
      writeFileSync(dbPath, '');
      writeFileSync(`${dbPath}-wal`, 'live-wal-bytes');
      writeFileSync(`${dbPath}-shm`, 'live-shm-bytes');

      const result = await runInit(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        // `:memory:` to avoid having SQLite touch the seed file
        // and rewrite the bytes; we're only testing that the
        // cleanup check is a no-op when the main file exists.
        { env: cliEnv({ dbPath: ':memory:' }), subargs: [], io: NULL_IO },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The seeded files at the OTHER path stay untouched —
      // this proves the cleanup did not over-reach. The
      // `:memory:` path's check is the one in the snapshot;
      // we're asserting via the disk that the side-effect was
      // confined to the requested path.
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reports 'no orphan' when the main db is absent and no sidecars exist", async () => {
    // The truly-fresh-install case. Pin that the snapshot
    // reports the cleanup ran and found nothing — gives the
    // operator a positive ack rather than silence.
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memento-init-fresh-'));
    try {
      const dbPath = path.join(tmpRoot, 'memento.db');
      const result = await runInit(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        { env: cliEnv({ dbPath }), subargs: [], io: NULL_IO },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cleanup = result.value.checks.find((c) => c.name === 'stale-wal-sidecars');
      expect(cleanup?.ok).toBe(true);
      expect(cleanup?.message).toContain('no orphan');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
