// `memento completions` lifecycle command tests.
//
// Pure: drives `runCompletions` with shell arguments and asserts
// the output scripts contain expected shell-specific markers.

import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runCompletions } from '../src/lifecycle/completions.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';

const NULL_DEPS: LifecycleDeps = {
  createApp: async () => {
    throw new Error('createApp should not be called from runCompletions');
  },
  migrateStore: async () => {
    throw new Error('migrateStore should not be called from runCompletions');
  },
  serveStdio: async () => {
    throw new Error('serveStdio should not be called from runCompletions');
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

const cliEnv = (): CliEnv => ({
  dbPath: ':memory:',
  format: 'json',
  debug: false,
});

describe('runCompletions', () => {
  it('returns INVALID_INPUT when no shell argument is provided', async () => {
    const { io } = captureIO();
    const result = await runCompletions(NULL_DEPS, {
      env: cliEnv(),
      subargs: [],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('bash | zsh | fish');
  });

  it('returns INVALID_INPUT for an unsupported shell', async () => {
    const { io } = captureIO();
    const result = await runCompletions(NULL_DEPS, {
      env: cliEnv(),
      subargs: ['powershell'],
      io,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain("unsupported shell 'powershell'");
  });

  it('generates a bash completion script', async () => {
    const { io } = captureIO();
    const result = await runCompletions(NULL_DEPS, {
      env: cliEnv(),
      subargs: ['bash'],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shell).toBe('bash');
    expect(result.value.script).toContain('_memento_complete');
    expect(result.value.script).toContain('complete -F _memento_complete memento');
    expect(result.value.script).toContain('COMPREPLY');
    expect(result.value.script).toContain('serve');
  });

  it('generates a zsh completion script', async () => {
    const { io } = captureIO();
    const result = await runCompletions(NULL_DEPS, {
      env: cliEnv(),
      subargs: ['zsh'],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shell).toBe('zsh');
    expect(result.value.script).toContain('#compdef memento');
    expect(result.value.script).toContain('_memento');
    expect(result.value.script).toContain('_describe');
  });

  it('generates a fish completion script', async () => {
    const { io } = captureIO();
    const result = await runCompletions(NULL_DEPS, {
      env: cliEnv(),
      subargs: ['fish'],
      io,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shell).toBe('fish');
    expect(result.value.script).toContain('complete -c memento');
    expect(result.value.script).toContain('serve');
    expect(result.value.script).toContain('--help');
  });
});
