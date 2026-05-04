// `memento skill-path` lifecycle command tests.
//
// Validates:
//   - happy path: returns the staged source + suggested target,
//   - missing-bundle path: returns NOT_FOUND with the suggested
//     target preserved in `details` so a script branching on $?
//     can still print a useful message,
//   - argv hygiene: extra positional args fail with INVALID_INPUT.
//
// The resolver itself (`resolveSkillSourceDir`) has its own unit
// coverage. Here we only need to know which branch we hit, so
// the `vi.mock` on `skill-source.js` is the smallest fixture
// that exercises both branches deterministically.

import { describe, expect, it, vi } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { runSkillPath } from '../src/lifecycle/skill-path.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';

vi.mock('../src/skill-source.js', () => {
  // Mutable holder so tests can flip the resolved value per case.
  // Matches the runtime contract: `resolveSkillSourceDir` returns
  // `string | null`; `suggestedSkillTargetDir` always a string.
  const state = { source: '/abs/path/to/skills/memento' as string | null };
  return {
    __esModule: true,
    __state: state,
    resolveSkillSourceDir: (): string | null => state.source,
    suggestedSkillTargetDir: (): string => '/Users/test/.claude/skills',
  };
});

// Pull the mock state back out so individual tests can flip it.
// The `as` cast is a deliberate test-only escape: vitest's mock
// surface is loosely typed and we know the shape.
const mockState = (await import('../src/skill-source.js')) as unknown as {
  __state: { source: string | null };
};

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

const cliEnv = (): CliEnv => ({ dbPath: ':memory:', format: 'json', debug: false });

const NULL_DEPS: LifecycleDeps = {
  createApp: () => {
    throw new Error('createApp should not be called from runSkillPath');
  },
  migrateStore: async () => {
    throw new Error('migrateStore should not be called from runSkillPath');
  },
  serveStdio: async () => {
    throw new Error('serveStdio should not be called from runSkillPath');
  },
};

describe('runSkillPath', () => {
  it('returns the staged source and suggested target on the happy path', async () => {
    mockState.__state.source = '/abs/path/to/skills/memento';
    const result = await runSkillPath(NULL_DEPS, {
      env: cliEnv(),
      subargs: [],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('/abs/path/to/skills/memento');
    expect(result.value.suggestedTarget).toBe('/Users/test/.claude/skills');
  });

  it('returns NOT_FOUND when the bundle is not staged', async () => {
    mockState.__state.source = null;
    const result = await runSkillPath(NULL_DEPS, {
      env: cliEnv(),
      subargs: [],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
    // `details.suggestedTarget` is the contract for callers that
    // want to print a useful message even on the missing-bundle
    // path. Pinned here so refactors keep it.
    const details = result.error.details as { suggestedTarget?: string } | undefined;
    expect(details?.suggestedTarget).toBe('/Users/test/.claude/skills');
  });

  it('rejects extra positional arguments with INVALID_INPUT', async () => {
    mockState.__state.source = '/abs/path/to/skills/memento';
    const result = await runSkillPath(NULL_DEPS, {
      env: cliEnv(),
      subargs: ['extra'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});
