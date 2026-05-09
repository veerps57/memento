// `memento pack <action>` lifecycle command tests.
//
// Drives `runPack` against a real in-memory MementoApp. The
// pack engine is fully exercised in core's tests; this file
// focuses on the CLI-side concerns: argv parsing, action
// dispatch, and the source flag → registry input translation.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMementoApp } from '@psraghuveer/memento-core';
import { afterEach, describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { type ScriptedAnswers, createScriptedPrompter } from '../src/lifecycle/pack-prompts.js';
import { runPack } from '../src/lifecycle/pack.js';
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
  const dir = await mkdtemp(join(tmpdir(), 'memento-cli-pack-'));
  dirs.push(dir);
  return dir;
}

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

const TTY_IO: CliIO = { ...NULL_IO, isTTY: true };

function depsWithPrompter(script: ScriptedAnswers): LifecycleDeps {
  return {
    ...baseDeps,
    createPackPrompter: () => createScriptedPrompter(script),
  };
}

const cliEnv = (overrides: Partial<CliEnv> = {}): CliEnv => ({
  dbPath: ':memory:',
  format: 'json',
  debug: false,
  ...overrides,
});

const baseDeps: LifecycleDeps = {
  createApp: createMementoApp,
  migrateStore: async () => {
    throw new Error('migrateStore should not be called from runPack');
  },
  serveStdio: async () => {
    throw new Error('serveStdio should not be called from runPack');
  },
};

const yamlPack = `
format: memento-pack/v1
id: test-pack
version: 1.0.0
title: Test pack
memories:
  - kind: fact
    content: First fact.
  - kind: preference
    content: pnpm-only.
`;

describe('runPack: argv parsing', () => {
  it('rejects when no action is supplied', async () => {
    const result = await runPack(baseDeps, { env: cliEnv(), subargs: [], io: NULL_IO });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/action required/);
  });

  it('rejects an unknown action with the valid set', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['nope'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/unknown action/);
    expect(result.error.message).toMatch(/install/);
  });

  it('rejects an unknown flag for the chosen action', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['install', '--bogus'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/unknown flag/);
  });
});

describe('runPack: install', () => {
  it('installs from a local --from-file path', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'pack.yaml');
    await writeFile(path, yamlPack);

    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['install', '--from-file', path],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { state: string; itemCount: number };
    expect(value.state).toBe('fresh');
    expect(value.itemCount).toBe(2);
  });

  it('installs from a bundled id resolved against packs.bundledRegistryPath', async () => {
    const bundledRoot = await tmpDir();
    const dir = join(bundledRoot, 'test-pack');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'v1.0.0.yaml'), yamlPack);

    const deps: LifecycleDeps = {
      ...baseDeps,
      createApp: (opts) =>
        createMementoApp({
          ...opts,
          configOverrides: { 'packs.bundledRegistryPath': bundledRoot },
        }),
    };
    const result = await runPack(deps, {
      env: cliEnv(),
      subargs: ['install', 'test-pack', '--version', '1.0.0'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects install when no source is supplied', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['install'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/--from-file|--from-url|<id>/);
  });
});

describe('runPack: uninstall', () => {
  it('rejects uninstall when neither --version nor --all-versions is supplied', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['uninstall', 'test-pack', '--dry-run', '--confirm'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/--version|--all-versions/);
  });

  it('forwards --version + --all-versions correctly to the registry command', async () => {
    const dir = await tmpDir();
    const path = join(dir, 'pack.yaml');
    await writeFile(path, yamlPack);

    // Install via --from-file, then uninstall by version.
    await runPack(baseDeps, {
      env: cliEnv({ dbPath: join(dir, 'test.db') }),
      subargs: ['install', '--from-file', path],
      io: NULL_IO,
    });
    // NB: each runPack call opens its own MementoApp and closes
    // it; using a file-backed DB so state persists across calls.
    const result = await runPack(baseDeps, {
      env: cliEnv({ dbPath: join(dir, 'test.db') }),
      subargs: ['uninstall', 'test-pack', '--version', '1.0.0', '--dry-run', '--confirm'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; dryRun: boolean };
    expect(value.dryRun).toBe(true);
    expect(value.matched).toBe(2);
  });
});

describe('runPack: list', () => {
  it('returns empty packs on an empty store', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['list'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { packs: unknown[] };
    expect(value.packs).toEqual([]);
  });
});

describe('runPack: create', () => {
  async function seed(dbPath: string): Promise<void> {
    // Seed two memories in the global scope so pack.export has
    // material to bundle. We round-trip through the CLI's own
    // registry to keep the integration honest.
    const app = await createMementoApp({ dbPath });
    try {
      await app.memoryRepository.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'self' },
          kind: { type: 'fact' },
          tags: ['rust'],
          pinned: false,
          content: 'Rust is the language we use here.',
          summary: null,
          storedConfidence: 1,
        },
        { actor: { type: 'cli' } },
      );
      await app.memoryRepository.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'self' },
          kind: { type: 'preference' },
          tags: ['build'],
          pinned: false,
          content: 'Use pnpm for Node projects.',
          summary: null,
          storedConfidence: 1,
        },
        { actor: { type: 'cli' } },
      );
    } finally {
      app.close();
    }
  }

  it('rejects when --out is missing', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['create', 'my-pack', '--version', '0.1.0', '--title', 'My pack'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/--out/);
  });

  it('rejects when <id> / --id is missing', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['create', '--out', '/tmp/x.yaml', '--version', '0.1.0', '--title', 'My pack'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/<id>|--id/);
  });

  it('rejects when --version is missing', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['create', 'my-pack', '--out', '/tmp/x.yaml', '--title', 'My pack'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/--version/);
  });

  it('rejects when --title is missing', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: ['create', 'my-pack', '--out', '/tmp/x.yaml', '--version', '0.1.0'],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/--title/);
  });

  it('rejects when --scope-* flags are supplied more than once', async () => {
    const result = await runPack(baseDeps, {
      env: cliEnv(),
      subargs: [
        'create',
        'my-pack',
        '--out',
        '/tmp/x.yaml',
        '--version',
        '0.1.0',
        '--title',
        't',
        '--scope-global',
        '--scope-repo=github.com/x/y',
      ],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/mutually exclusive/);
  });

  it('writes a YAML file at --out', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seed(dbPath);

    const outPath = join(dir, 'my-pack.yaml');
    const result = await runPack(baseDeps, {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'my-pack',
        '--out',
        outPath,
        '--version',
        '0.1.0',
        '--title',
        'My pack',
        '--scope-global',
      ],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(outPath, 'utf8');
    expect(written).toContain('memento-pack/v1');
    expect(written).toContain('id: my-pack');
    expect(written).toContain('Rust is the language');
  });

  it('plumbs --kind / --tag / --pinned filters into the export', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seed(dbPath);

    const outPath = join(dir, 'pref-only.yaml');
    const result = await runPack(baseDeps, {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'pref-only',
        '--out',
        outPath,
        '--version',
        '0.1.0',
        '--title',
        'Preferences only',
        '--scope-global',
        '--kind',
        'preference',
        '--tag',
        'build',
      ],
      io: NULL_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { exported: number };
    expect(value.exported).toBe(1);
  });

  it('returns an INVALID_INPUT result when no memories match the filter', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seed(dbPath);

    const result = await runPack(baseDeps, {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'empty-pack',
        '--out',
        join(dir, 'empty.yaml'),
        '--version',
        '0.1.0',
        '--title',
        'Empty',
        '--kind',
        'todo',
      ],
      io: NULL_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('runPack: create (interactive review)', () => {
  async function seedTwo(dbPath: string): Promise<void> {
    const app = await createMementoApp({ dbPath });
    try {
      await app.memoryRepository.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'self' },
          kind: { type: 'fact' },
          tags: ['rust'],
          pinned: false,
          content: 'first memory',
          summary: null,
          storedConfidence: 1,
        },
        { actor: { type: 'cli' } },
      );
      await app.memoryRepository.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'self' },
          kind: { type: 'preference' },
          tags: ['build'],
          pinned: false,
          content: 'second memory',
          summary: null,
          storedConfidence: 1,
        },
        { actor: { type: 'cli' } },
      );
    } finally {
      app.close();
    }
  }

  it('triggers interactive review when isTTY=true and no filter flags are supplied', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seedTwo(dbPath);
    const outPath = join(dir, 'interactive.yaml');

    const result = await runPack(depsWithPrompter({ review: ['keep', 'keep'], confirm: 'yes' }), {
      env: cliEnv({ dbPath }),
      subargs: ['create', 'my-pack', '--out', outPath, '--version', '0.1.0', '--title', 'My pack'],
      io: TTY_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { exported: number };
    expect(value.exported).toBe(2);

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(outPath, 'utf8');
    expect(written).toContain('first memory');
    expect(written).toContain('second memory');
  });

  it('drops memories the user marks `skip`', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seedTwo(dbPath);
    const outPath = join(dir, 'partial.yaml');

    const result = await runPack(depsWithPrompter({ review: ['keep', 'skip'], confirm: 'yes' }), {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'partial-pack',
        '--out',
        outPath,
        '--version',
        '0.1.0',
        '--title',
        'Partial',
      ],
      io: TTY_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { exported: number };
    expect(value.exported).toBe(1);

    const { readFile } = await import('node:fs/promises');
    const written = await readFile(outPath, 'utf8');
    // The repo orders memories by `last_confirmed_at desc, id desc`,
    // so the second-written memory ("second memory") appears first
    // in the review and is the one we keep.
    expect(written).toContain('second memory');
    expect(written).not.toContain('first memory');
  });

  it('does NOT enter interactive mode when isTTY=true but filter flags are supplied', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seedTwo(dbPath);
    const outPath = join(dir, 'filter.yaml');

    // Scripted prompter would throw if reached; passing it lets
    // us assert the interactive path is bypassed.
    const result = await runPack(depsWithPrompter({ review: ['keep'], confirm: 'yes' }), {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'filtered-pack',
        '--out',
        outPath,
        '--version',
        '0.1.0',
        '--title',
        'Filtered',
        '--kind',
        'preference',
      ],
      io: TTY_IO,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { exported: number };
    expect(value.exported).toBe(1);
  });

  it('returns INVALID_INPUT when the user cancels mid-review', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seedTwo(dbPath);
    const result = await runPack(depsWithPrompter({ review: ['keep', 'cancel'] }), {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'cancelled-pack',
        '--out',
        join(dir, 'cancelled.yaml'),
        '--version',
        '0.1.0',
        '--title',
        'Cancelled',
      ],
      io: TTY_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/cancelled/);
  });

  it('returns INVALID_INPUT when the user declines the final confirmation', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seedTwo(dbPath);
    const outPath = join(dir, 'declined.yaml');

    const result = await runPack(depsWithPrompter({ review: ['keep', 'keep'], confirm: 'no' }), {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'declined-pack',
        '--out',
        outPath,
        '--version',
        '0.1.0',
        '--title',
        'Declined',
      ],
      io: TTY_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/cancelled/);
  });

  it('returns INVALID_INPUT when no memories are kept', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seedTwo(dbPath);
    const result = await runPack(depsWithPrompter({ review: ['skip', 'skip'] }), {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'nothing',
        '--out',
        join(dir, 'nothing.yaml'),
        '--version',
        '0.1.0',
        '--title',
        'Nothing',
      ],
      io: TTY_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/at least one/);
  });

  it('returns INVALID_INPUT when the store is empty', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');

    const result = await runPack(depsWithPrompter({}), {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'empty-store',
        '--out',
        join(dir, 'empty.yaml'),
        '--version',
        '0.1.0',
        '--title',
        'Empty',
      ],
      io: TTY_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/no active memories/);
  });

  it('returns INTERNAL when interactive mode is required but no prompter is wired', async () => {
    const dir = await tmpDir();
    const dbPath = join(dir, 'test.db');
    await seedTwo(dbPath);
    const result = await runPack(baseDeps, {
      env: cliEnv({ dbPath }),
      subargs: [
        'create',
        'no-prompter',
        '--out',
        join(dir, 'np.yaml'),
        '--version',
        '0.1.0',
        '--title',
        'NP',
      ],
      io: TTY_IO,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.message).toMatch(/prompter factory/);
  });
});
