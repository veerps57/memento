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

import type { ActorRef, Memory } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MementoApp, createMementoApp } from '../../src/bootstrap.js';
import { executeCommand } from '../../src/commands/execute.js';
import { createPackCommands } from '../../src/commands/packs/commands.js';
import { createDefaultPackSourceResolver } from '../../src/packs/resolve.js';

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

describe('pack.export', () => {
  it('builds a manifest from memories matching a filter', async () => {
    const { app } = await newAppWithBundledRoot();
    // Seed a few memories
    await executeCommand(
      getCommand(app, 'memory.write'),
      {
        scope: { type: 'global' },
        kind: { type: 'fact' },
        tags: ['rust'],
        content: 'Rust uses cargo',
      },
      ctx,
    );
    await executeCommand(
      getCommand(app, 'memory.write'),
      {
        scope: { type: 'global' },
        kind: { type: 'preference' },
        tags: ['build'],
        content: 'Use pnpm',
      },
      ctx,
    );

    const result = await executeCommand(
      getCommand(app, 'pack.export'),
      {
        packId: 'my-pack',
        version: '0.1.0',
        title: 'My pack',
        filter: { scope: { type: 'global' } },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exported).toBe(2);
    expect(result.value.yaml).toContain('memento-pack/v1');
    expect(result.value.yaml).toContain('id: my-pack');
  });

  it('refuses with INVALID_INPUT when no memories match the filter', async () => {
    const { app } = await newAppWithBundledRoot();
    const result = await executeCommand(
      getCommand(app, 'pack.export'),
      {
        packId: 'empty-pack',
        version: '0.1.0',
        title: 'Empty',
        filter: { kind: 'todo' },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/no memories matched/);
  });

  it('refuses when matched memories span multiple scopes', async () => {
    const { app } = await newAppWithBundledRoot();
    await executeCommand(
      getCommand(app, 'memory.write'),
      {
        scope: { type: 'global' },
        kind: { type: 'fact' },
        tags: [],
        content: 'g',
      },
      ctx,
    );
    await executeCommand(
      getCommand(app, 'memory.write'),
      {
        scope: { type: 'workspace', path: '/repo/x' },
        kind: { type: 'fact' },
        tags: [],
        content: 'w',
      },
      ctx,
    );
    const result = await executeCommand(
      getCommand(app, 'pack.export'),
      {
        packId: 'multi-pack',
        version: '0.1.0',
        title: 'Multi',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/single-scope/);
  });

  it('round-trips: write → export → install → idempotent', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    // Seed memories
    await executeCommand(
      getCommand(app, 'memory.write'),
      {
        scope: { type: 'global' },
        kind: { type: 'fact' },
        tags: ['rust'],
        content: 'Rust fact A',
      },
      ctx,
    );
    await executeCommand(
      getCommand(app, 'memory.write'),
      {
        scope: { type: 'global' },
        kind: { type: 'preference' },
        tags: ['build'],
        content: 'Use pnpm',
      },
      ctx,
    );

    // Export
    const exported = await executeCommand(
      getCommand(app, 'pack.export'),
      {
        packId: 'roundtrip',
        version: '0.1.0',
        title: 'Round-trip',
        filter: { scope: { type: 'global' } },
      },
      ctx,
    );
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    // Write the exported YAML to the bundled directory and install it
    await writeBundledPack(bundledRoot, 'roundtrip', '0.1.0', exported.value.yaml);
    const installed = await executeCommand(
      getCommand(app, 'pack.install'),
      {
        source: { type: 'bundled', id: 'roundtrip', version: '0.1.0' },
        dryRun: false,
      },
      ctx,
    );
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.state).toBe('fresh');
    expect(installed.value.written).toHaveLength(2);

    // Verify pack:roundtrip:0.1.0 tag is now stamped on two memories
    const list = await executeCommand(
      getCommand(app, 'memory.list'),
      { tags: ['pack:roundtrip:0.1.0'] },
      ctx,
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(2);
  });

  it('strips reserved-prefix tags from exported memories and reports the strip', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    // Install a pack so we have a memory with a `pack:*` tag
    await writeBundledPack(
      bundledRoot,
      'source-pack',
      '1.0.0',
      'format: memento-pack/v1\nid: source-pack\nversion: 1.0.0\ntitle: Source\nmemories:\n  - kind: fact\n    content: From a pack\n    tags: [rust]',
    );
    await executeCommand(
      getCommand(app, 'pack.install'),
      {
        source: { type: 'bundled', id: 'source-pack', version: '1.0.0' },
        dryRun: false,
      },
      ctx,
    );

    // Export again with a new pack id
    const result = await executeCommand(
      getCommand(app, 'pack.export'),
      {
        packId: 'derived-pack',
        version: '0.1.0',
        title: 'Derived',
        filter: { scope: { type: 'global' } },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.join('\n')).toMatch(/stripped/);
    expect(result.value.yaml).not.toContain('pack:source-pack:1.0.0');
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

// — afterWrite hook coverage —
//
// Regression tests for the "pack.install bypasses post-write
// hooks" defect. The original implementation called
// `memoryRepository.writeMany` directly, going around the
// command-level afterWrite hook chain wired in bootstrap.ts.
// Result: pack-installed memories silently skipped both
// conflict detection and auto-embed, leaving every
// pack-installed memory at `embeddingStatus: pending` until the
// user manually ran `embedding.rebuild`. These tests pin the
// fix: install fires `afterWrite` once per fresh memory and
// zero times for idempotent re-installs.

describe('pack.install afterWrite hook', () => {
  it('fires afterWrite once per freshly-written memory on a fresh install', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const fired: Memory[] = [];
    // Build a parallel command set with a spy hook. We use the
    // same MemoryRepository as the app so the existing pack-tag
    // assertions stay valid; only the afterWrite path differs.
    const spyCommands = createPackCommands({
      memoryRepository: app.memoryRepository,
      resolver: createDefaultPackSourceResolver({
        bundledRoot,
        allowRemoteUrls: false,
        urlFetchTimeoutMs: 1000,
        maxPackSizeBytes: 1024 * 1024,
      }),
      configStore: app.configStore,
      afterWrite: (memory) => {
        fired.push(memory);
      },
    });
    const installCommand = spyCommands.find((c) => c.name === 'pack.install');
    if (!installCommand) throw new Error('pack.install command missing');

    const result = await executeCommand(
      installCommand,
      {
        source: { type: 'bundled', id: 'test-pack', version: '1.0.0' },
        dryRun: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('fresh');
    // yamlBasic has 2 memories — both should fire the hook.
    expect(fired).toHaveLength(2);
    // Each fired memory carries the canonical pack tag.
    for (const m of fired) {
      expect(m.tags).toContain('pack:test-pack:1.0.0');
    }
  });

  it('does NOT fire afterWrite for idempotent re-installs', async () => {
    const { app, bundledRoot } = await newAppWithBundledRoot();
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    // First install via the app (no spy, just to populate the
    // store) so the second invocation is the idempotent path.
    const first = await executeCommand(
      getCommand(app, 'pack.install'),
      {
        source: { type: 'bundled', id: 'test-pack', version: '1.0.0' },
        dryRun: false,
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state).toBe('fresh');

    // Second install — same content, same version → idempotent.
    const fired: Memory[] = [];
    const spyCommands = createPackCommands({
      memoryRepository: app.memoryRepository,
      resolver: createDefaultPackSourceResolver({
        bundledRoot,
        allowRemoteUrls: false,
        urlFetchTimeoutMs: 1000,
        maxPackSizeBytes: 1024 * 1024,
      }),
      configStore: app.configStore,
      afterWrite: (memory) => {
        fired.push(memory);
      },
    });
    const installCommand = spyCommands.find((c) => c.name === 'pack.install');
    if (!installCommand) throw new Error('pack.install command missing');

    const second = await executeCommand(
      installCommand,
      {
        source: { type: 'bundled', id: 'test-pack', version: '1.0.0' },
        dryRun: false,
      },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state).toBe('idempotent');
    // The hook never fires for items resolved by clientToken
    // idempotency — same skip rule as memory.write_many.
    expect(fired).toHaveLength(0);
  });

  it('end-to-end: pack-installed memories have embeddings present by the time install resolves (sync)', async () => {
    // The fix-PR contract (ADR-0021): when a host wires an
    // embedder, `pack.install` must batch-embed all freshly-
    // written memories before the handler resolves. No polling,
    // no fire-and-forget — by the time `executeCommand`
    // returns, every fresh memory is `embeddingStatus: present`
    // and `provider.embedBatch`/`provider.embed` has been
    // called for the full batch.
    const bundledRoot = await mkdtemp(join(tmpdir(), 'memento-pack-cmd-embed-'));
    tempDirs.push(bundledRoot);
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    let embedBatchCalls = 0;
    let totalTextsEmbedded = 0;
    const fakeProvider = {
      model: 'fake-test-model',
      dimension: 3,
      embed: async (_text: string) => [0.1, 0.2, 0.3] as readonly number[],
      embedBatch: async (texts: readonly string[]) => {
        embedBatchCalls += 1;
        totalTextsEmbedded += texts.length;
        return texts.map(() => [0.1, 0.2, 0.3] as readonly number[]);
      },
    };
    const app = await createMementoApp({
      dbPath: ':memory:',
      configOverrides: {
        'packs.bundledRegistryPath': bundledRoot,
        'embedding.autoEmbed': true,
        // Disable startup backfill — this test is about install-time
        // sync behavior; backfill would mask a regression where the
        // install path silently skipped embed.
        'embedding.startupBackfill.enabled': false,
      },
      embeddingProvider: fakeProvider,
    });
    apps.push(app);

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

    // Sync contract: embed has happened before install
    // resolved. Single batch call covering both memories — the
    // helper uses embedBatch under the hood, not 2 sequential
    // embed() calls.
    expect(embedBatchCalls).toBe(1);
    expect(totalTextsEmbedded).toBe(2);

    // No polling needed — embeddings are present immediately
    // after install resolves.
    const list = await executeCommand(
      getCommand(app, 'memory.list'),
      { tags: ['pack:test-pack:1.0.0'], includeEmbedding: true },
      ctx,
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(2);
    for (const m of list.value) {
      expect(m.embeddingStatus).toBe('present');
    }
  });

  it('install succeeds even when the embedder fails (best-effort embed)', async () => {
    // Partial-failure policy: embed errors must not poison the
    // install Result. The memories are still written with the
    // canonical pack tag; embeddings are recoverable via
    // `embedding.rebuild`.
    const bundledRoot = await mkdtemp(join(tmpdir(), 'memento-pack-cmd-embed-fail-'));
    tempDirs.push(bundledRoot);
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const failingProvider = {
      model: 'broken-test-model',
      dimension: 3,
      embed: async (_text: string): Promise<readonly number[]> => {
        throw new Error('embed failure');
      },
      embedBatch: async (_texts: readonly string[]): Promise<readonly (readonly number[])[]> => {
        throw new Error('batch failure');
      },
    };
    const app = await createMementoApp({
      dbPath: ':memory:',
      configOverrides: {
        'packs.bundledRegistryPath': bundledRoot,
        'embedding.autoEmbed': true,
        'embedding.startupBackfill.enabled': false,
      },
      embeddingProvider: failingProvider,
    });
    apps.push(app);

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

    // Memories landed; embeddings did not.
    const list = await executeCommand(
      getCommand(app, 'memory.list'),
      { tags: ['pack:test-pack:1.0.0'], includeEmbedding: true },
      ctx,
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(2);
    for (const m of list.value) {
      // Embedding never wrote — status is whatever the
      // store-default + missing-vector projection produces.
      // The important assertion: the memory exists and is
      // active.
      expect(m.status).toBe('active');
    }
  });

  it('install does not embed when host has not wired an embedder (no provider)', async () => {
    // When `retrieval.vector.enabled` is false the host doesn't
    // pass an `embeddingProvider` and bootstrap omits the
    // `embedAndStore` callback entirely. Install must still
    // succeed; memories land without vectors.
    const bundledRoot = await mkdtemp(join(tmpdir(), 'memento-pack-cmd-novector-'));
    tempDirs.push(bundledRoot);
    await writeBundledPack(bundledRoot, 'test-pack', '1.0.0', yamlBasic);

    const app = await createMementoApp({
      dbPath: ':memory:',
      configOverrides: {
        'packs.bundledRegistryPath': bundledRoot,
      },
      // No embeddingProvider supplied — vector retrieval off.
    });
    apps.push(app);

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
  });
});
