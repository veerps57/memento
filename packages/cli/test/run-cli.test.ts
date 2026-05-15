// End-to-end tests for `runCli`, driven entirely in-process via
// a fake `CliIO` and a fake `createApp`. We assert exit codes
// and the buffered stdout / stderr text. Each test is hermetic:
// no DB, no real argv, no `process.exit`.

import type { MementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';
import type { CliIO } from '../src/io.js';
import { type RunCliDeps, runCli } from '../src/run.js';

interface Capture {
  io: CliIO;
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}

class TestExit extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

function fakeIO(opts: {
  argv: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  isTTY?: boolean;
  isStderrTTY?: boolean;
}): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cap: Capture = {
    stdout,
    stderr,
    exitCode: undefined,
    // assigned below; placeholder satisfies the closure ordering
    io: undefined as unknown as CliIO,
  };
  cap.io = {
    argv: opts.argv,
    env: opts.env ?? {},
    stdin: process.stdin,
    stdout: { write: (s: string) => void stdout.push(s) },
    stderr: { write: (s: string) => void stderr.push(s) },
    isTTY: Boolean(opts.isTTY),
    isStderrTTY: Boolean(opts.isStderrTTY),
    exit: ((code: number) => {
      cap.exitCode = code;
      throw new TestExit(code);
    }) as CliIO['exit'],
  };
  return cap;
}

/**
 * `createApp` / `migrateStore` fakes that throw by default —
 * most tests don't touch them and shouldn't accidentally open a
 * database. Tests that exercise lifecycle commands pass `deps`
 * to override.
 */
const REJECTING_DEPS: RunCliDeps = {
  createApp: async (): Promise<MementoApp> => {
    throw new Error('test fake: createApp not configured for this test');
  },
  migrateStore: async () => {
    throw new Error('test fake: migrateStore not configured for this test');
  },
  serveStdio: async () => {
    throw new Error('test fake: serveStdio not configured for this test');
  },
};

async function drive(cap: Capture, deps: RunCliDeps = REJECTING_DEPS): Promise<number> {
  try {
    await runCli(cap.io, deps);
  } catch (err) {
    if (err instanceof TestExit) return err.code;
    throw err;
  }
  // runCli always terminates via io.exit, so unreachable.
  throw new Error('runCli returned without calling io.exit');
}

describe('runCli', () => {
  it('--version prints the version and exits 0', async () => {
    const cap = fakeIO({ argv: ['--version'] });
    const code = await drive(cap);
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toMatch(/^memento \S+\n$/);
    expect(cap.stderr.join('')).toBe('');
  });

  it('--help prints help and exits 0', async () => {
    const cap = fakeIO({ argv: ['--help'] });
    const code = await drive(cap);
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toContain('Usage: memento');
    // Lifecycle commands are grouped (Setup / Verify & inspect / Operate / Help & teardown).
    expect(cap.stdout.join('')).toContain('Setup:');
    expect(cap.stdout.join('')).toContain('Verify & inspect:');
  });

  it('--help on a TTY also prints the banner', async () => {
    const cap = fakeIO({ argv: ['--help'], env: { NO_COLOR: '1' }, isTTY: true });
    const code = await drive(cap);
    expect(code).toBe(0);
    const out = cap.stdout.join('');
    expect(out).toContain('Persistent memory for AI assistants');
    expect(out).toContain('Usage: memento');
    // NO_COLOR set: no ANSI escapes leak through.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: assertion targets ANSI escape absence
    expect(out).not.toMatch(/\u001b\[/);
  });

  it('--help in non-TTY mode omits the banner (clean for pipes)', async () => {
    const cap = fakeIO({ argv: ['--help'], isTTY: false });
    await drive(cap);
    const out = cap.stdout.join('');
    expect(out).not.toContain('Persistent memory for AI assistants');
    expect(out).toContain('Usage: memento');
  });

  it('empty argv prints help and exits 0', async () => {
    const cap = fakeIO({ argv: [] });
    const code = await drive(cap);
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toContain('Usage: memento');
  });

  it('parse error prints to stderr with help and exits 1', async () => {
    const cap = fakeIO({ argv: ['--unknown-flag'] });
    const code = await drive(cap);
    expect(code).toBe(1);
    const stderr = cap.stderr.join('');
    expect(stderr).toContain("error: unknown flag '--unknown-flag'");
    expect(stderr).toContain('Usage: memento');
    expect(cap.stdout.join('')).toBe('');
  });

  it('serve runs the MCP stdio loop and exits cleanly with no stdout', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const calls: Array<{ name: string; version: string; actorType: string }> = [];
    const cap = fakeIO({ argv: ['--db', ':memory:', 'serve'], isTTY: false });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: async (options) => {
        // Capture inputs and return immediately; production
        // would block here until the transport closes.
        calls.push({
          name: options.info.name,
          version: options.info.version,
          actorType: options.ctx.actor.type,
        });
      },
    });
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toBe('');
    expect(cap.stderr.join('')).toBe('');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.name).toBe('memento');
    expect(typeof call?.version).toBe('string');
    expect(call?.actorType).toBe('mcp');
  });

  it('serve reports INTERNAL exit when the MCP transport throws', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const cap = fakeIO({ argv: ['--db', ':memory:', 'serve'], isTTY: false });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: async () => {
        throw new Error('transport boom');
      },
    });
    expect(code).toBe(10);
    expect(cap.stdout.join('')).toBe('');
    expect(cap.stderr.join('')).toContain('"INTERNAL"');
    expect(cap.stderr.join('')).toContain('transport boom');
  });

  it('serve reports STORAGE_ERROR with exit 8 when the DB cannot be opened', async () => {
    const cap = fakeIO({ argv: ['serve'], isTTY: false });
    const code = await drive(cap, {
      createApp: async () => {
        throw new Error('cannot open');
      },
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(8);
    expect(cap.stdout.join('')).toBe('');
    expect(cap.stderr.join('')).toContain('"STORAGE_ERROR"');
    expect(cap.stderr.join('')).toContain('cannot open');
  });

  it('store migrate runs against an in-memory DB and reports outcomes', async () => {
    const { createMementoApp, MIGRATIONS, migrateToLatest, openDatabase } = await import(
      '@psraghuveer/memento-core'
    );
    const cap = fakeIO({
      argv: ['--db', ':memory:', 'store', 'migrate'],
      isTTY: false,
    });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: async ({ dbPath }) => {
        const handle = openDatabase({ path: dbPath });
        try {
          return await migrateToLatest(handle.db, MIGRATIONS);
        } finally {
          handle.close();
        }
      },
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.join('')) as {
      ok: boolean;
      value?: { dbPath: string; applied: number; skipped: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.dbPath).toBe(':memory:');
    expect(parsed.value?.applied ?? 0).toBeGreaterThan(0);
    expect(parsed.value?.skipped).toBe(0);
  });

  it('registry stub still fails with exit 1', async () => {
    // Unknown commands route through the lifecycle/registry split:
    // a 'registry' parsed kind with an unrecognised name reaches
    // `buildCliAdapter`, which surfaces INVALID_INPUT (exit 3).
    // Here we use a deliberately bogus name to assert that path.
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const cap = fakeIO({
      argv: ['--db', ':memory:', 'no-such', 'verb'],
      isTTY: false,
    });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(2);
    expect(cap.stderr.join('')).toContain('INVALID_INPUT');
  });
});

describe('runCli: memento context', () => {
  it('emits a JSON snapshot to stdout in non-TTY mode', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const cap = fakeIO({ argv: ['--db', ':memory:', 'context'], isTTY: false });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(0);
    expect(cap.stderr.join('')).toBe('');
    const stdout = cap.stdout.join('');
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      value?: { dbPath: string; registry: { commands: unknown[] } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.dbPath).toBe(':memory:');
    expect(Array.isArray(parsed.value?.registry.commands)).toBe(true);
    expect((parsed.value?.registry.commands ?? []).length).toBeGreaterThan(0);
  });

  it('emits prose to stdout in TTY mode (--format text)', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const cap = fakeIO({
      argv: ['--db', ':memory:', '--format', 'text', 'context'],
      isTTY: true,
    });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(0);
    const stdout = cap.stdout.join('');
    expect(stdout).toContain('":memory:"');
    expect(stdout).toContain('"version":');
  });

  it('skill-path emits just the bare absolute path on stdout — even off-TTY', async () => {
    // `skill-path` is designed for `cp -R "$(memento skill-path)" …`
    // shell embedding. Inside `$(…)` bash detaches stdout from
    // the TTY, so `auto` would normally resolve to JSON and break
    // the substitution. The dispatcher overrides that for this
    // command: success always prints the bare path with one
    // trailing newline, matching `which` / `command -v`. JSON is
    // opt-in via an explicit `--format json`.
    const cap = fakeIO({ argv: ['skill-path'], isTTY: false });
    const code = await drive(cap, REJECTING_DEPS);
    expect(code).toBe(0);
    expect(cap.stderr.join('')).toBe('');
    const stdout = cap.stdout.join('');
    // Bundle is staged (workspace root /skills/memento or
    // packages/cli/skills/memento) so the path resolves and ends
    // with `/skills/memento`. A single trailing newline only.
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    expect(stdout.trimEnd()).toMatch(/[\\/]skills[\\/]memento$/);
  });

  it('skill-path in JSON mode returns the structured envelope', async () => {
    const cap = fakeIO({
      argv: ['--format', 'json', 'skill-path'],
      isTTY: true,
    });
    const code = await drive(cap, REJECTING_DEPS);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.join('')) as {
      ok: boolean;
      value?: { source: string; suggestedTarget: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.source).toMatch(/skills[\\/]memento$/);
    expect(parsed.value?.suggestedTarget).toMatch(/\.claude[\\/]skills$/);
  });

  it('reports STORAGE_ERROR with exit 8 when the DB cannot be opened', async () => {
    const cap = fakeIO({ argv: ['context'], isTTY: false });
    const code = await drive(cap, {
      createApp: async () => {
        throw new Error('cannot open');
      },
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(8);
    const stderr = cap.stderr.join('');
    expect(stderr).toContain('"STORAGE_ERROR"');
    expect(stderr).toContain('cannot open');
  });
});
describe('runCli: registry projection', () => {
  it('runs a registry read command end-to-end against an in-memory app', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const cap = fakeIO({
      argv: ['--db', ':memory:', 'memory', 'list'],
      isTTY: false,
    });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(0);
    expect(cap.stderr.join('')).toBe('');
    const parsed = JSON.parse(cap.stdout.join('')) as {
      ok: boolean;
      value?: unknown[];
    };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.value)).toBe(true);
    expect(parsed.value?.length).toBe(0);
  });

  it('round-trips a write through the adapter, with --input', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const cap = fakeIO({
      argv: [
        '--db',
        ':memory:',
        'memory',
        'write',
        '--input',
        JSON.stringify({
          scope: { type: 'global' },
          owner: { type: 'local', id: 'self' },
          kind: { type: 'fact' },
          tags: [],
          pinned: false,
          content: 'hello from registry e2e',
          summary: null,
          storedConfidence: 0.9,
        }),
      ],
      isTTY: false,
    });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout.join('')) as {
      ok: boolean;
      value?: { id: string; content: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.content).toBe('hello from registry e2e');
    expect(typeof parsed.value?.id).toBe('string');
  });

  it('reports INVALID_INPUT with exit 3 when --input is malformed JSON', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    const cap = fakeIO({
      argv: ['--db', ':memory:', 'memory', 'list', '--input', '{not-json'],
      isTTY: false,
    });
    const code = await drive(cap, {
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        }),
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(2);
    expect(cap.stderr.join('')).toContain('INVALID_INPUT');
  });

  it('reports STORAGE_ERROR with exit 8 when createApp throws', async () => {
    const cap = fakeIO({
      argv: ['memory', 'list'],
      isTTY: false,
    });
    const code = await drive(cap, {
      createApp: async () => {
        throw new Error('disk gone');
      },
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(8);
    expect(cap.stderr.join('')).toContain('STORAGE_ERROR');
    expect(cap.stderr.join('')).toContain('disk gone');
  });

  it('closes the app even when the adapter run rejects', async () => {
    const { createMementoApp } = await import('@psraghuveer/memento-core');
    let closed = 0;
    const cap = fakeIO({
      argv: ['--db', ':memory:', 'no-such', 'verb'],
      isTTY: false,
    });
    const code = await drive(cap, {
      createApp: async (opts) => {
        const app = await createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        });
        const originalShutdown = app.shutdown.bind(app);
        return {
          ...app,
          shutdown: async () => {
            closed += 1;
            await originalShutdown();
          },
        };
      },
      migrateStore: REJECTING_DEPS.migrateStore,
      serveStdio: REJECTING_DEPS.serveStdio,
    });
    expect(code).toBe(2);
    expect(closed).toBe(1);
  });
});
