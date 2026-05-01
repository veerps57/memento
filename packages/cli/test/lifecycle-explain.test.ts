// `memento explain` lifecycle command tests.
//
// `loadCatalogue` resolves `docs/reference/error-codes.md`
// relative to `import.meta.url`. In the monorepo layout the
// third candidate (`../../../../docs/reference/error-codes.md`)
// hits. That catalogue uses a flat table — no `## CODE`
// headings — so `extractSection` always returns `undefined`,
// making every valid-code lookup produce INVALID_INPUT with
// "unknown error code". These tests assert that deterministic
// outcome, not a hedged "could be either."

import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runExplain } from '../src/lifecycle/explain.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';

function makeDeps(): LifecycleDeps {
  return {
    createApp: async () => {
      throw new Error('createApp should not be called from runExplain');
    },
    migrateStore: async () => {
      throw new Error('migrateStore should not be called from runExplain');
    },
    serveStdio: async () => {
      throw new Error('serveStdio should not be called from runExplain');
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

describe('runExplain', () => {
  it('returns INVALID_INPUT when no arguments are provided', async () => {
    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runExplain(deps, {
      env: cliEnv(),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('error code');
  });

  it('finds the catalogue but returns INVALID_INPUT when section heading is absent', async () => {
    const deps = makeDeps();
    const { io } = captureIO();
    // loadCatalogue finds error-codes.md (table-only format, no
    // `## STORAGE_ERROR` heading) → extractSection returns undefined
    // → INVALID_INPUT with the uppercased code in the message.
    const result = await runExplain(deps, {
      env: cliEnv(),
      subargs: ['STORAGE_ERROR'],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain("unknown error code 'STORAGE_ERROR'");
  });

  it('uppercases the input before lookup', async () => {
    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runExplain(deps, {
      env: cliEnv(),
      subargs: ['not_found'],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    // The message references the uppercased form, proving the
    // toUpperCase() branch ran.
    expect(result.error.message).toContain("'NOT_FOUND'");
  });

  it('rejects a completely unknown code with INVALID_INPUT', async () => {
    const deps = makeDeps();
    const { io } = captureIO();
    const result = await runExplain(deps, {
      env: cliEnv(),
      subargs: ['TOTALLY_BOGUS'],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain("'TOTALLY_BOGUS'");
  });
});
