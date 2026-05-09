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
