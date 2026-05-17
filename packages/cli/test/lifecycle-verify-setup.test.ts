// `memento verify-setup` lifecycle command tests.
//
// Covers two transport modes (ADR-0028):
//   - `subprocess` (default) — spawn `node <cli> serve` and talk
//     stdio. Catches "the binary won't start", "MCP handshake
//     fails", "instructions field missing", which are the
//     adoption-killing failures.
//   - `engine-only` (--engine-only or no built CLI) — in-process
//     `buildMementoServer` paired with `InMemoryTransport`.
//     Used in dev / CI when `dist/cli.js` is unavailable.
//
// Plus per-step assertions (tools/list, write, search, cleanup)
// shared by both modes.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type CreateMementoAppOptions, createMementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';
import { runVerifySetup } from '../src/lifecycle/verify-setup.js';

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
  throw new Error('migrateStore should not be called from runVerifySetup');
};

const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called from runVerifySetup');
};

// Subprocess mode requires the built CLI at packages/cli/dist/cli.js.
// We gate the subprocess-specific test on the binary existing so the
// suite still passes on a fresh checkout that hasn't run `pnpm build`.
const CLI_DIST = path.resolve(__dirname, '..', 'dist', 'cli.js');
const cliBuilt = existsSync(CLI_DIST);

describe('runVerifySetup (engine-only mode)', () => {
  it('walks tools/list, info_system, write, search, and cleanup on the happy path', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memento-verify-'));
    try {
      const dbPath = path.join(tmpRoot, 'memento.db');
      const result = await runVerifySetup(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        // --engine-only opts out of the subprocess path so this
        // test stays deterministic and fast regardless of build state.
        { env: cliEnv({ dbPath }), subargs: ['--engine-only'], io: NULL_IO },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.ok).toBe(true);
      expect(result.value.transport).toBe('engine-only');

      const names = result.value.checks.map((c) => c.name);
      // Engine-only does not run the spawn-and-initialize +
      // instructions-field checks (those are subprocess-only).
      expect(names).toEqual([
        'tools-list',
        'info-system',
        'write-memory',
        'search-memory',
        'cleanup',
      ]);
      for (const check of result.value.checks) {
        expect(check.ok).toBe(true);
        if (check.name !== 'cleanup') {
          expect(typeof check.elapsedMs).toBe('number');
        }
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('leaves no test memory behind after a successful run', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memento-verify-cleanup-'));
    try {
      const dbPath = path.join(tmpRoot, 'memento.db');
      const result = await runVerifySetup(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        { env: cliEnv({ dbPath }), subargs: ['--engine-only'], io: NULL_IO },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const app = await createAppNoVector({ dbPath });
      try {
        const listCmd = app.registry.get('memory.list');
        if (!listCmd) throw new Error('memory.list missing');
        const { executeCommand } = await import('@psraghuveer/memento-core');
        const listResult = await executeCommand(
          listCmd,
          { status: 'active', tags: ['memento:verify-setup'] },
          { actor: { type: 'cli' } },
        );
        expect(listResult.ok).toBe(true);
        if (!listResult.ok) return;
        const memories = listResult.value as readonly unknown[];
        expect(memories.length).toBe(0);
      } finally {
        await app.shutdown();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects unknown arguments with INVALID_INPUT', async () => {
    const result = await runVerifySetup(
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
    expect(result.error.message).toMatch(/--bogus/);
  });
});

// Subprocess-mode tests gated on the built CLI. Skipped in dev
// trees that haven't run `pnpm build` so the unit suite stays
// fast (subprocess spawn adds ~500ms-2s per test) and so that
// "cold checkout → run tests" works without an extra build step.
//
// CI's verify chain always builds first, so this branch runs in
// CI.
(cliBuilt ? describe : describe.skip)('runVerifySetup (subprocess mode)', () => {
  it('spawns node <cli> serve, completes initialize, and round-trips a write/search', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'memento-verify-subproc-'));
    try {
      const dbPath = path.join(tmpRoot, 'memento.db');
      const result = await runVerifySetup(
        {
          createApp: createAppNoVector,
          migrateStore: rejectMigrateStore,
          serveStdio: rejectServeStdio,
        },
        {
          env: cliEnv({ dbPath }),
          subargs: [], // default = subprocess mode
          io: { ...NULL_IO, env: { ...process.env, MEMENTO_DB: dbPath } as Record<string, string> },
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transport).toBe('subprocess');
      expect(result.value.ok).toBe(true);

      const names = result.value.checks.map((c) => c.name);
      // Subprocess mode adds two checks at the front: the spawn
      // + initialize, and the instructions-field validation.
      expect(names).toContain('spawn-and-initialize');
      expect(names).toContain('instructions-field');
      expect(names).toContain('tools-list');
      expect(names).toContain('info-system');
      expect(names).toContain('write-memory');
      expect(names).toContain('search-memory');
      expect(names).toContain('cleanup');

      // The instructions-field check carries the spine size in
      // its message — a sanity bound (>100, <10000 chars) catches
      // a regression where the spine becomes empty or balloons.
      const instructionsCheck = result.value.checks.find((c) => c.name === 'instructions-field');
      expect(instructionsCheck?.ok).toBe(true);
      expect(instructionsCheck?.message).toMatch(/\d+\s+chars/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000); // subprocess + initialize can be ~500-2000ms on cold runs
});
