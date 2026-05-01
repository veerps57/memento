// `memento serve` lifecycle command tests.
//
// `serve` blocks until the MCP transport closes, so production
// would never resolve. Tests inject a fake `serveStdio` that
// returns immediately (or rejects) and assert:
//
//   - the wiring (registry + ctx + info) handed to serveStdio,
//   - the `mcp` actor identity (with `agent: 'memento/<version>'`),
//   - app.close() runs exactly once (covers transport-throws path),
//   - error mapping (createApp throw → STORAGE_ERROR; serveStdio
//     throw → INTERNAL).

import { createMementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runServe } from '../src/lifecycle/serve.js';
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
  throw new Error('migrateStore should not be called from runServe');
};

describe('runServe', () => {
  it('hands the registry, mcp ctx, and serverInfo to serveStdio', async () => {
    const captured: Array<{
      hasRegistry: boolean;
      actorType: string;
      agent: string | undefined;
      infoName: string;
      infoVersion: string;
    }> = [];
    const result = await runServe(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: async (options) => {
          // `agent` only exists on the `mcp` discriminant.
          const actor = options.ctx.actor;
          captured.push({
            hasRegistry: typeof options.registry.list === 'function',
            actorType: actor.type,
            agent: actor.type === 'mcp' ? actor.agent : undefined,
            infoName: options.info.name,
            infoVersion: options.info.version,
          });
        },
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const c = captured[0];
    expect(c?.hasRegistry).toBe(true);
    expect(c?.actorType).toBe('mcp');
    expect(c?.agent).toMatch(/^memento\//);
    expect(c?.infoName).toBe('memento');
    expect(typeof c?.infoVersion).toBe('string');
    expect((c?.infoVersion ?? '').length).toBeGreaterThan(0);
  });

  it('returns STORAGE_ERROR when createApp throws', async () => {
    const result = await runServe(
      {
        createApp: async () => {
          throw new Error('disk on fire');
        },
        migrateStore: rejectMigrateStore,
        serveStdio: async () => {
          throw new Error('serveStdio should not be reached');
        },
      },
      { env: cliEnv({ dbPath: '/no/such/path.db' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.message).toContain('/no/such/path.db');
    expect(result.error.message).toContain('disk on fire');
  });

  it('returns INTERNAL when the MCP transport throws and still closes the app', async () => {
    let closed = false;
    const real = await createAppNoVector({ dbPath: ':memory:' });
    const result = await runServe(
      {
        createApp: async () => ({
          ...real,
          close: () => {
            closed = true;
            real.close();
          },
        }),
        migrateStore: rejectMigrateStore,
        serveStdio: async () => {
          throw new Error('transport boom');
        },
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.message).toContain('transport boom');
    // The `finally` block in runServe must run app.close() even
    // on transport failure so the SQLite handle is not leaked.
    expect(closed).toBe(true);
  });

  it('closes the app on the success path', async () => {
    let closed = false;
    const real = await createAppNoVector({ dbPath: ':memory:' });
    const result = await runServe(
      {
        createApp: async () => ({
          ...real,
          close: () => {
            closed = true;
            real.close();
          },
        }),
        migrateStore: rejectMigrateStore,
        serveStdio: async () => undefined,
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    expect(closed).toBe(true);
  });

  it('writes a readiness line to stderr when stderr is a TTY', async () => {
    const stderr: string[] = [];
    const ttyIO: CliIO = {
      ...NULL_IO,
      env: { NO_COLOR: '1' },
      stderr: { write: (s: string) => void stderr.push(s) },
      isStderrTTY: true,
    };
    const result = await runServe(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: async () => undefined,
      },
      { env: cliEnv({ dbPath: ':memory:' }), subargs: [], io: ttyIO },
    );
    expect(result.ok).toBe(true);
    const text = stderr.join('');
    // Figlet banner (matches --help) is the first thing a human sees.
    expect(text).toContain('Persistent memory for AI assistants');
    // Followed by the operational readiness line.
    expect(text).toContain('MCP server ready on stdio');
    expect(text).toContain('db: :memory:');
    // NO_COLOR=1 must suppress ANSI even when isStderrTTY is true.
    expect(text).not.toContain('\u001b[');
  });

  it('writes nothing to stderr when stderr is not a TTY (MCP-launched)', async () => {
    const stderr: string[] = [];
    const pipedIO: CliIO = {
      ...NULL_IO,
      stderr: { write: (s: string) => void stderr.push(s) },
      isStderrTTY: false,
    };
    const result = await runServe(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: async () => undefined,
      },
      { env: cliEnv(), subargs: [], io: pipedIO },
    );
    expect(result.ok).toBe(true);
    expect(stderr.join('')).toBe('');
  });
});
