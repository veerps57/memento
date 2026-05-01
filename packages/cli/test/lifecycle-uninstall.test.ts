// `memento uninstall` lifecycle command tests.
//
// Pure: drives `runUninstall` and asserts the returned snapshot
// contains the expected entry labels and paths.

import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';
import { runUninstall } from '../src/lifecycle/uninstall.js';

const NULL_DEPS: LifecycleDeps = {
  createApp: async () => {
    throw new Error('createApp should not be called from runUninstall');
  },
  migrateStore: async () => {
    throw new Error('migrateStore should not be called from runUninstall');
  },
  serveStdio: async () => {
    throw new Error('serveStdio should not be called from runUninstall');
  },
};

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

describe('runUninstall', () => {
  it('returns a snapshot with expected entry labels for :memory: db', async () => {
    const { io } = captureIO();
    const result = await runUninstall(NULL_DEPS, {
      env: cliEnv(),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBeDefined();
    const labels = result.value.entries.map((e) => e.label);
    expect(labels).toContain('Database');
    expect(labels).toContain('Claude Code (user scope)');
    expect(labels).toContain('Claude Code (project scope)');
    expect(labels).toContain('Claude Desktop');
    expect(labels).toContain('Cursor');
    expect(labels).toContain('VS Code');
    expect(labels).toContain('OpenCode');
    expect(labels).toContain('Package');
  });

  it('includes in-memory action text for :memory: databases', async () => {
    const { io } = captureIO();
    const result = await runUninstall(NULL_DEPS, {
      env: cliEnv({ dbPath: ':memory:' }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dbEntry = result.value.entries.find((e) => e.label === 'Database');
    expect(dbEntry?.action).toContain('in-memory');
  });

  it('includes backup suggestion for on-disk databases', async () => {
    const { io } = captureIO();
    const result = await runUninstall(NULL_DEPS, {
      env: cliEnv({ dbPath: '/tmp/test-memento.db' }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dbEntry = result.value.entries.find((e) => e.label === 'Database');
    expect(dbEntry?.action).toContain('memento backup');
    expect(dbEntry?.path).toBe('/tmp/test-memento.db');
  });

  it('resolves relative db paths to absolute', async () => {
    const { io } = captureIO();
    const result = await runUninstall(NULL_DEPS, {
      env: cliEnv({ dbPath: './relative/path.db' }),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dbEntry = result.value.entries.find((e) => e.label === 'Database');
    // Should be absolute (starts with /)
    expect(dbEntry?.path.startsWith('/')).toBe(true);
    expect(dbEntry?.path).toContain('relative/path.db');
  });
});
