// Integration tests for the `pack.*` registered command set.
// Spins up a real in-memory `MementoApp` so the commands hit the
// composed pipeline (resolver → parser → translator → write_many
// → forget_many) instead of mocked seams. Pack manifests come from
// in-memory fixtures via `bundledOverride`-style resolver swapping.
//
// Verifies:
//   - install: fresh / idempotent / drift state machine
//   - preview: read-only, returns same shape as install dry-run
//   - uninstall: single-version + all-versions paths
//   - list: groups installed memories by `pack:<id>:<version>` tag
//   - reserved-tag enforcement: user writes can't claim `pack:*`

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MementoApp, createMementoApp } from '../../src/bootstrap.js';
import { executeCommand } from '../../src/commands/execute.js';

const ctx = { actor: { type: 'cli' } as ActorRef };

const apps: MementoApp[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (apps.length > 0) apps.pop()?.close();
  tempDirs.length = 0;
});

async function newAppWithBundledRoot(): Promise<{ app: MementoApp; bundledRoot: string }> {
  const bundledRoot = await mkdtemp(join(tmpdir(), 'memento-pack-cmd-'));
  tempDirs.push(bundledRoot);
  const app = await createMementoApp({
    dbPath: ':memory:',
    configOverrides: { 'packs.bundledRegistryPath': bundledRoot },
  });
  apps.push(app);
  return { app, bundledRoot };
}

function getCommand(app: MementoApp, name: string) {
  const command = app.registry.get(name);
  if (!command) throw new Error(`command ${name} is not registered`);
  return command;
}

async function writeBundledPack(
  bundledRoot: string,
  id: string,
  version: string,
  yaml: string,
): Promise<void> {
  const dir = join(bundledRoot, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `v${version}.yaml`), yaml);
}

const yamlBasic = `
format: memento-pack/v1
id: test-pack
version: 1.0.0
title: Test pack
memories:
  - kind: fact
    content: First fact from the pack.
  - kind: preference
    content: pnpm-only.
    tags: [build]
`;

const yamlEdited = `
format: memento-pack/v1
id: test-pack
version: 1.0.0
title: Test pack
memories:
  - kind: fact
    content: First fact from the pack.
  - kind: preference
    content: yarn now (drift!).
    tags: [build]
`;

const yamlV2 = `
format: memento-pack/v1
id: test-pack
version: 1.1.0
title: Test pack v1.1
memories:
  - kind: fact
    content: First fact from the pack v1.1.
`;

describe('pack.install', () => {
  it('runs a fresh install: writes memories, stamps pack tag', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const result = await executeCommand(
      getCommand(app, 'pack.install'),
      {
        source: { type: 'bundled', id: 'test-pack', version: '1.0.0' },
        dryRun: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('fresh');
    expect(result.value.written).toHaveLength(2);
    expect(result.value.alreadyInstalled).toBe(false);

    // Verify stamped provenance via memory.list
    const list = await executeCommand(
      getCommand(app, 'memory.list'),
      { tags: ['pack:test-pack:1.0.0'] },
      ctx,
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(2);
  });

  it('returns idempotent on re-install with identical content (no-op)', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const first = await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );
    expect(first.ok).toBe(true);

    const second = await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state).toBe('idempotent');
    expect(second.value.alreadyInstalled).toBe(true);
    expect(second.value.written).toHaveLength(0);
  });

  it('refuses with PACK_VERSION_REUSED when content changes without a version bump', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const first = await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );
    expect(first.ok).toBe(true);

    // Overwrite the bundled yaml with edited content but same version
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlEdited);
    const second = await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('INVALID_INPUT');
    const details = second.error.details as { errorKind?: string };
    expect(details.errorKind).toBe('PACK_VERSION_REUSED');
    expect(second.error.message).toContain('Bump the manifest version');
  });

  it('dryRun: true returns the would-be plan without writing', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const result = await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(result.value.state).toBe('fresh');
    expect(result.value.itemCount).toBe(2);
    expect(result.value.written).toHaveLength(0);

    const listed = await executeCommand(
      getCommand(app, 'memory.list'),
      { tags: ['pack:test-pack:1.0.0'] },
      ctx,
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(0);
  });
});

describe('pack.preview', () => {
  it('returns the manifest plan and `state: fresh` against an empty store', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const result = await executeCommand(
      getCommand(app, 'pack.preview'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('fresh');
    expect(result.value.itemCount).toBe(2);
    expect(result.value.items[0]?.tags).toContain('pack:test-pack:1.0.0');
  });

  it('returns drift state when the manifest content has changed under the same version', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);
    await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );

    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlEdited);
    const result = await executeCommand(
      getCommand(app, 'pack.preview'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('drift');
    expect(result.value.driftReason).toContain('changed');
  });
});

describe('pack.uninstall', () => {
  it('forgets every memory installed by the pack on apply', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);
    await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );

    const dryRun = await executeCommand(
      getCommand(app, 'pack.uninstall'),
      { id: 'test-pack', version: '1.0.0', dryRun: true, confirm: true },
      ctx,
    );
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) return;
    expect(dryRun.value.matched).toBe(2);
    expect(dryRun.value.applied).toBe(0);

    const apply = await executeCommand(
      getCommand(app, 'pack.uninstall'),
      { id: 'test-pack', version: '1.0.0', dryRun: false, confirm: true },
      ctx,
    );
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.value.applied).toBe(2);

    // After uninstall, no active memories carry the tag
    const list = await executeCommand(
      getCommand(app, 'memory.list'),
      { tags: ['pack:test-pack:1.0.0'], status: 'active' },
      ctx,
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(0);
  });

  it('all-versions: removes every version of the pack', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);
    await writeBundledPack(bundledRoot, 'test-pack', '1.1.0', yamlV2);

    await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );
    await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.1.0' }, dryRun: false },
      ctx,
    );

    const result = await executeCommand(
      getCommand(app, 'pack.uninstall'),
      { id: 'test-pack', allVersions: true, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBeGreaterThanOrEqual(3); // 2 from v1.0.0 + 1 from v1.1.0
    expect(result.value.version).toBeNull();
  });

  it('rejects when neither version nor allVersions is supplied', async () => {
    const { app } = await newAppWithBundledRoot();
    const result = await executeCommand(
      getCommand(app, 'pack.uninstall'),
      { id: 'test-pack', dryRun: true, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});

describe('pack.preview', () => {
  it('returns idempotent state when the same manifest is already installed', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);
    await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );
    const result = await executeCommand(
      getCommand(app, 'pack.preview'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('idempotent');
  });
});

describe('pack.uninstall (more)', () => {
  it('refuses on apply when matched count exceeds safety.bulkDestructiveLimit', async () => {
    const bundledRoot = await mkdtemp(join(tmpdir(), 'memento-pack-cap-'));
    tempDirs.push(bundledRoot);
    const app = await createMementoApp({
      dbPath: ':memory:',
      configOverrides: {
        'packs.bundledRegistryPath': bundledRoot,
        'safety.bulkDestructiveLimit': 1,
      },
    });
    apps.push(app);
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);
    await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );

    // Apply path: 2 memories matched > cap of 1 → INVALID_INPUT
    const result = await executeCommand(
      getCommand(app, 'pack.uninstall'),
      { id: 'test-pack', version: '1.0.0', dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/safety\.bulkDestructiveLimit/);
  });
});

describe('pack.list', () => {
  it('groups installed memories by pack id and version', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);
    await executeCommand(
      getCommand(app, 'pack.install'),
      { source: { type: 'bundled', id: 'test-pack', version: '1.0.0' }, dryRun: false },
      ctx,
    );

    const result = await executeCommand(getCommand(app, 'pack.list'), {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.packs).toHaveLength(1);
    expect(result.value.packs[0]?.id).toBe('test-pack');
    expect(result.value.packs[0]?.version).toBe('1.0.0');
    expect(result.value.packs[0]?.count).toBe(2);
  });
});

describe('reserved tag enforcement', () => {
  it('rejects user writes that try to claim the `pack:` namespace', async () => {
    const { app } = await newAppWithBundledRoot();
    const result = await executeCommand(
      getCommand(app, 'memory.write'),
      {
        scope: { type: 'global' },
        kind: { type: 'fact' },
        tags: ['pack:forged:1.0.0'],
        content: 'forged provenance attempt',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('reserved prefix');
  });

  it('rejects memory.write_many items that try to claim the `pack:` namespace', async () => {
    const { app } = await newAppWithBundledRoot();
    const result = await executeCommand(
      getCommand(app, 'memory.write_many'),
      {
        items: [
          {
            scope: { type: 'global' },
            kind: { type: 'fact' },
            tags: ['rust'],
            content: 'first',
          },
          {
            scope: { type: 'global' },
            kind: { type: 'fact' },
            tags: ['pack:forged:1.0.0'],
            content: 'forged item',
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/items\[1\]/);
  });

  it('rejects extract candidates with reserved tags', async () => {
    const { app } = await newAppWithBundledRoot();
    const result = await executeCommand(
      getCommand(app, 'memory.extract'),
      {
        candidates: [
          {
            kind: 'fact',
            content: 'attempt',
            tags: ['pack:forged:1.0.0'],
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});
