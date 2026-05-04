// Tests for `system.info` and `system.list_scopes`. These are
// integration-flavoured: they spin up a real (in-memory)
// `MementoApp` and exercise the commands through the registry,
// because the value of these probes is precisely that they
// reflect live wiring rather than a stub.
//
// What we assert
// --------------
//   * `system.info`
//     - returns the threaded `appVersion` and the schema version
//       constant
//     - reports `dbPath` as the value passed to `createMementoApp`
//       (`:memory:` here) and `null` when an adopted handle is
//       used (covered indirectly via the `dbPath` field shape)
//     - reflects the embedder-presence flag both ways
//     - reflects `retrieval.vector.enabled` from the *current*
//       config layer, not the snapshot at app open
//     - tallies counts by status correctly across active /
//       superseded / archived / forgotten transitions
//   * `system.list_scopes`
//     - groups by canonical scope and counts active rows
//     - returns rows sorted by count desc
//     - excludes scopes whose only memories are non-active

import type { ActorRef, Scope } from '@psraghuveer/memento-schema';
import { ScopeSchema } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type MementoApp, createMementoApp } from '../../src/bootstrap.js';
import { executeCommand } from '../../src/commands/execute.js';
import type { EmbeddingProvider } from '../../src/embedding/provider.js';

const apps: MementoApp[] = [];

afterEach(() => {
  while (apps.length > 0) apps.pop()?.close();
});

async function newApp(opts: Parameters<typeof createMementoApp>[0]): Promise<MementoApp> {
  const app = await createMementoApp(opts);
  apps.push(app);
  return app;
}

const ctx = { actor: { type: 'cli' } as ActorRef };

const baseWrite = {
  owner: { type: 'local' as const, id: 'tester' },
  kind: { type: 'fact' as const },
  tags: [] as string[],
  pinned: false,
  summary: null,
  storedConfidence: 0.9,
};

async function write(app: MementoApp, scope: Scope, content: string): Promise<string> {
  const cmd = app.registry.get('memory.write');
  if (!cmd) throw new Error('memory.write missing');
  const result = await executeCommand(cmd, { ...baseWrite, scope, content }, ctx);
  if (!result.ok) throw new Error(`write failed: ${result.error.code}`);
  return (result.value as { id: string }).id;
}

interface SystemInfo {
  version: string;
  schemaVersion: number;
  dbPath: string | null;
  vectorEnabled: boolean;
  embedder: { configured: boolean; model: string; dimension: number };
  counts: { active: number; archived: number; forgotten: number; superseded: number };
  openConflicts: number;
  runtime: { node: string; modulesAbi: string; nativeBinding: 'ok' };
  scrubber: { enabled: boolean };
  user: { preferredName: string | null };
}

async function info(app: MementoApp): Promise<SystemInfo> {
  const cmd = app.registry.get('system.info');
  if (!cmd) throw new Error('system.info missing');
  const result = await executeCommand(cmd, {}, ctx);
  if (!result.ok) throw new Error(`system.info failed: ${result.error.code}`);
  return result.value as SystemInfo;
}

describe('system.info', () => {
  it('reports threaded version and the schema-version constant', async () => {
    const app = await newApp({ dbPath: ':memory:', appVersion: '1.2.3-test' });
    const out = await info(app);
    expect(out.version).toBe('1.2.3-test');
    expect(typeof out.schemaVersion).toBe('number');
    expect((out.schemaVersion as number) >= 1).toBe(true);
  });

  it("falls back to 'unknown' when the host omits appVersion", async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const out = await info(app);
    expect(out.version).toBe('unknown');
  });

  it('reports the dbPath the engine opened', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const out = await info(app);
    expect(out.dbPath).toBe(':memory:');
  });

  it('reflects embedder presence', async () => {
    const noEmbedder = await newApp({ dbPath: ':memory:' });
    expect((await info(noEmbedder)).embedder).toMatchObject({ configured: false });

    const provider: EmbeddingProvider = {
      model: 'stub',
      dimension: 3,
      embed: async () => [0, 0, 0],
    };
    const withEmbedder = await newApp({ dbPath: ':memory:', embeddingProvider: provider });
    expect((await info(withEmbedder)).embedder).toMatchObject({ configured: true });
  });

  it('reflects live config changes for vectorEnabled', async () => {
    // Start with vector retrieval explicitly disabled, then flip
    // it via `config.set` and re-probe. A snapshot-at-open
    // implementation would fail this test.
    const app = await newApp({
      dbPath: ':memory:',
      configOverrides: { 'retrieval.vector.enabled': false },
    });
    expect((await info(app)).vectorEnabled).toBe(false);

    const setCmd = app.registry.get('config.set');
    if (!setCmd) throw new Error('config.set missing');
    const setResult = await executeCommand(
      setCmd,
      { key: 'retrieval.vector.enabled', value: true },
      ctx,
    );
    expect(setResult.ok).toBe(true);

    expect((await info(app)).vectorEnabled).toBe(true);
  });

  // Persona-3 follow-up. The skill teaches AIs to attribute writes
  // ("Raghu prefers pnpm" rather than "User prefers pnpm"), but
  // there was no canonical way to discover the user's preferred
  // handle. `system.info.user.preferredName` is now that surface,
  // backed by the `user.preferredName` config key.
  it('returns user.preferredName from config (null by default)', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const out = await info(app);
    expect(out.user).toEqual({ preferredName: null });
  });

  it('reflects a configured user.preferredName', async () => {
    const app = await newApp({
      dbPath: ':memory:',
      configOverrides: { 'user.preferredName': 'Raghu' },
    });
    const out = await info(app);
    expect(out.user).toEqual({ preferredName: 'Raghu' });
  });

  it('counts memories by status', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const scope: Scope = { type: 'global' };

    const a = await write(app, scope, 'fact one');
    await write(app, scope, 'fact two');
    await write(app, scope, 'fact three');

    // archive one row
    const archive = app.registry.get('memory.archive');
    if (!archive) throw new Error('memory.archive missing');
    const archived = await executeCommand(archive, { id: a, confirm: true }, ctx);
    expect(archived.ok).toBe(true);

    const out = await info(app);
    expect(out.counts).toMatchObject({
      active: 2,
      archived: 1,
      forgotten: 0,
      superseded: 0,
    });
  });

  it('reports zero open conflicts on a freshly seeded store', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const out = await info(app);
    expect(out.openConflicts).toBe(0);
  });

  it('counts unresolved conflicts and decrements after resolve', async () => {
    // Two contradictory `package-manager` preferences in the same
    // scope must surface a conflict (the post-write hook OR a
    // forced scan opens it; we don't care which). Resolving it
    // must decrement `openConflicts`. This pins the dashboard
    // overview tile's contract: post-resolve refresh sees a
    // monotonically smaller number, not the same `1000+` page-cap
    // residue the old `conflict.list`-based count produced.
    const app = await newApp({ dbPath: ':memory:' });
    const writeCmd = app.registry.get('memory.write');
    if (!writeCmd) throw new Error('memory.write missing');
    await executeCommand(
      writeCmd,
      {
        ...baseWrite,
        scope: { type: 'global' as const },
        kind: { type: 'preference' as const },
        tags: ['topic:package-manager'],
        content: 'package-manager: pnpm\n\nPrefer pnpm for Node projects.',
      },
      ctx,
    );
    await executeCommand(
      writeCmd,
      {
        ...baseWrite,
        scope: { type: 'global' as const },
        kind: { type: 'preference' as const },
        tags: ['topic:package-manager'],
        content: 'package-manager: npm\n\nPrefer npm for Node projects.',
      },
      ctx,
    );

    // Force a 24h scan in case the async post-write hook hasn't
    // landed yet under test timing. With the dedup fix, the
    // scan no-ops if the hook already opened the conflict —
    // either way, reading `system.info` after this point yields
    // the deterministic open count.
    const scan = app.registry.get('conflict.scan');
    if (!scan) throw new Error('conflict.scan missing');
    const scanResult = await executeCommand(
      scan,
      { mode: 'since', since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
      ctx,
    );
    if (!scanResult.ok) throw new Error(`scan failed: ${scanResult.error.code}`);

    const before = await info(app);
    expect(before.openConflicts).toBeGreaterThan(0);

    // Pick whichever open conflict the run produced.
    const list = app.registry.get('conflict.list');
    if (!list) throw new Error('conflict.list missing');
    const listResult = await executeCommand(list, { open: true, limit: 10 }, ctx);
    if (!listResult.ok) throw new Error(`list failed: ${listResult.error.code}`);
    const rows = listResult.value as ReadonlyArray<{ id: string }>;
    const conflictId = rows[0]?.id;
    if (conflictId === undefined) throw new Error('expected at least one open conflict');

    // Resolve and re-probe.
    const resolve = app.registry.get('conflict.resolve');
    if (!resolve) throw new Error('conflict.resolve missing');
    const resolveResult = await executeCommand(
      resolve,
      { id: conflictId, resolution: 'ignore' as const },
      ctx,
    );
    if (!resolveResult.ok) throw new Error(`resolve failed: ${resolveResult.error.code}`);

    const after = await info(app);
    expect(after.openConflicts).toBe(before.openConflicts - 1);
  });

  it('exposes runtime info matching the host process', async () => {
    // Pin the runtime block: the dashboard's /system probes the
    // exact same fields, so a silent rename of `node` /
    // `modulesAbi` would break the UI. `nativeBinding` is always
    // `'ok'` because reaching the handler means better-sqlite3
    // is loaded.
    const app = await newApp({ dbPath: ':memory:' });
    const out = await info(app);
    expect(out.runtime).toEqual({
      node: process.versions.node,
      modulesAbi: process.versions.modules,
      nativeBinding: 'ok',
    });
  });

  it('reports scrubber state so the dashboard /system probe can render it', async () => {
    // The scrubber master switch (`scrubber.enabled`) is pinned
    // at server start. Lifting the resolved value into
    // `system.info` lets the dashboard show a "safety net
    // active?" indicator without a separate config.get call.
    // Default is `true`; the override path is exercised below.
    const onByDefault = await newApp({ dbPath: ':memory:' });
    expect((await info(onByDefault)).scrubber).toEqual({ enabled: true });

    const turnedOff = await newApp({
      dbPath: ':memory:',
      configOverrides: { 'scrubber.enabled': false },
    });
    expect((await info(turnedOff)).scrubber).toEqual({ enabled: false });
  });
});

describe('system.list_tags', () => {
  it('returns tags sorted by frequency descending', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const scope: Scope = { type: 'global' };

    // Write memories with overlapping tags.
    const writeCmd = app.registry.get('memory.write');
    if (!writeCmd) throw new Error('memory.write missing');
    await executeCommand(
      writeCmd,
      { ...baseWrite, scope, content: 'a', tags: ['arch', 'config'] },
      ctx,
    );
    await executeCommand(
      writeCmd,
      { ...baseWrite, scope, content: 'b', tags: ['arch', 'testing'] },
      ctx,
    );
    await executeCommand(writeCmd, { ...baseWrite, scope, content: 'c', tags: ['arch'] }, ctx);

    const cmd = app.registry.get('system.list_tags');
    if (!cmd) throw new Error('system.list_tags missing');
    const result = await executeCommand(cmd, {}, ctx);
    if (!result.ok) throw new Error(`failed: ${result.error.code}`);
    const out = result.value as { tags: Array<{ tag: string; count: number }> };

    expect(out.tags).toEqual([
      { tag: 'arch', count: 3 },
      { tag: 'config', count: 1 },
      { tag: 'testing', count: 1 },
    ]);
  });

  it('defaults to active-only and respects status filter', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const scope: Scope = { type: 'global' };

    const writeCmd = app.registry.get('memory.write');
    if (!writeCmd) throw new Error('memory.write missing');
    const r1 = await executeCommand(
      writeCmd,
      { ...baseWrite, scope, content: 'a', tags: ['alive'] },
      ctx,
    );
    if (!r1.ok) throw new Error('write failed');
    const r2 = await executeCommand(
      writeCmd,
      { ...baseWrite, scope, content: 'b', tags: ['doomed'] },
      ctx,
    );
    if (!r2.ok) throw new Error('write failed');

    // Archive the second memory.
    const archive = app.registry.get('memory.archive');
    if (!archive) throw new Error('memory.archive missing');
    await executeCommand(archive, { id: (r2.value as { id: string }).id, confirm: true }, ctx);

    const cmd = app.registry.get('system.list_tags');
    if (!cmd) throw new Error('system.list_tags missing');

    // Default (active) should only show 'alive'.
    const active = await executeCommand(cmd, {}, ctx);
    if (!active.ok) throw new Error('list_tags failed');
    expect((active.value as { tags: Array<{ tag: string }> }).tags.map((t) => t.tag)).toEqual([
      'alive',
    ]);

    // Explicit archived filter shows 'doomed'.
    const archived = await executeCommand(cmd, { status: 'archived' }, ctx);
    if (!archived.ok) throw new Error('list_tags failed');
    expect((archived.value as { tags: Array<{ tag: string }> }).tags.map((t) => t.tag)).toEqual([
      'doomed',
    ]);
  });

  it('returns empty tags array when no memories exist', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const cmd = app.registry.get('system.list_tags');
    if (!cmd) throw new Error('system.list_tags missing');
    const result = await executeCommand(cmd, {}, ctx);
    if (!result.ok) throw new Error(result.error.code);
    expect((result.value as { tags: unknown[] }).tags).toEqual([]);
  });
});

describe('system.list_scopes', () => {
  it('groups by scope, sorts by count desc, and ignores non-active rows', async () => {
    const app = await newApp({ dbPath: ':memory:' });

    const global: Scope = { type: 'global' };
    const ws: Scope = ScopeSchema.parse({ type: 'workspace', path: '/tmp/ws' });
    const repo: Scope = ScopeSchema.parse({
      type: 'repo',
      remote: 'github.com/acme/r',
    });

    await write(app, global, 'g1');
    await write(app, global, 'g2');
    await write(app, global, 'g3');
    await write(app, ws, 'w1');

    // repo gets one active row, then we archive it — list_scopes
    // must drop the bucket entirely.
    const r1 = await write(app, repo, 'r1');
    const archive = app.registry.get('memory.archive');
    if (!archive) throw new Error('memory.archive missing');
    await executeCommand(archive, { id: r1, confirm: true }, ctx);

    const cmd = app.registry.get('system.list_scopes');
    if (!cmd) throw new Error('system.list_scopes missing');
    const result = await executeCommand(cmd, {}, ctx);
    if (!result.ok) throw new Error(`failed: ${result.error.code}`);
    const out = result.value as {
      scopes: Array<{ scope: Scope; count: number; lastWriteAt: string | null }>;
    };

    const types = out.scopes.map((s) => s.scope.type);
    expect(types).toEqual(['global', 'workspace']);
    expect(out.scopes[0]?.count).toBe(3);
    expect(out.scopes[1]?.count).toBe(1);
    for (const row of out.scopes) {
      expect(typeof row.lastWriteAt).toBe('string');
    }
  });

  it('returns an empty list when no memories exist', async () => {
    const app = await newApp({ dbPath: ':memory:' });
    const cmd = app.registry.get('system.list_scopes');
    if (!cmd) throw new Error('system.list_scopes missing');
    const result = await executeCommand(cmd, {}, ctx);
    if (!result.ok) throw new Error(result.error.code);
    expect((result.value as { scopes: unknown[] }).scopes).toEqual([]);
  });
});
