// Tests for the composition root. The bootstrap is the only
// place in the codebase where every subsystem meets, so the
// tests here are integration-flavored: spin up a real (in-memory)
// SQLite, exercise commands through the registry, and assert the
// wired-in behaviors (most importantly that the conflict hook
// fires post-write and attributes events to the writer's actor).

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type MementoApp, createMementoApp } from '../src/bootstrap.js';
import { executeCommand } from '../src/commands/execute.js';
import type { ConfigOverrides } from '../src/config/index.js';
import type { EmbeddingProvider } from '../src/embedding/provider.js';

const apps: MementoApp[] = [];

afterEach(() => {
  while (apps.length > 0) {
    apps.pop()?.close();
  }
});

async function newApp(
  options: {
    embeddingProvider?: EmbeddingProvider;
    configOverrides?: ConfigOverrides;
  } = {},
): Promise<MementoApp> {
  const opts: Parameters<typeof createMementoApp>[0] = { dbPath: ':memory:' };
  if (options.embeddingProvider !== undefined) {
    (opts as { embeddingProvider?: EmbeddingProvider }).embeddingProvider =
      options.embeddingProvider;
  }
  if (options.configOverrides !== undefined) {
    (opts as { configOverrides?: ConfigOverrides }).configOverrides = options.configOverrides;
  }
  const app = await createMementoApp(opts);
  apps.push(app);
  return app;
}

const ctx = { actor: { type: 'cli' } as ActorRef };

const baseWriteInput = {
  scope: { type: 'global' as const },
  owner: { type: 'local' as const, id: 'tester' },
  kind: { type: 'fact' as const },
  tags: [] as string[],
  pinned: false,
  content: '',
  summary: null,
  storedConfidence: 0.9,
};

describe('createMementoApp', () => {
  it('rejects calls that supply both or neither of dbPath/database', async () => {
    await expect(createMementoApp({})).rejects.toThrow(/exactly one of 'dbPath' or 'database'/);
  });

  it('registers the full v1 command set (no embedding provider)', async () => {
    const app = await newApp();
    const names = app.registry
      .list()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(
      [
        'memory.read',
        'memory.list',
        'memory.events',
        'memory.write',
        'memory.write_many',
        'memory.update',
        'memory.confirm',
        'memory.confirm_many',
        'memory.supersede',
        'memory.archive',
        'memory.restore',
        'memory.forget',
        'memory.forget_many',
        'memory.archive_many',
        'memory.set_embedding',
        'memory.search',
        'memory.context',
        'memory.extract',
        'conflict.list',
        'conflict.read',
        'conflict.events',
        'conflict.resolve',
        'conflict.scan',
        'compact.run',
        'config.get',
        'config.list',
        'config.set',
        'config.unset',
        'config.history',
        'system.info',
        'system.list_scopes',
        'system.list_tags',
        'pack.install',
        'pack.preview',
        'pack.uninstall',
        'pack.list',
        'pack.export',
      ].sort(),
    );
  });

  it('adds embedding.rebuild only when an embedding provider is supplied', async () => {
    const provider: EmbeddingProvider = {
      model: 'test-model',
      dimension: 3,
      embed: async () => [0.1, 0.2, 0.3],
    };
    const app = await newApp({ embeddingProvider: provider });
    const names = new Set(app.registry.list().map((c) => c.name));
    expect(names.has('embedding.rebuild')).toBe(true);
  });

  it('exposes every command on both MCP and CLI surfaces', async () => {
    const app = await newApp();
    for (const cmd of app.registry.list()) {
      expect(cmd.surfaces).toContain('mcp');
      expect(cmd.surfaces).toContain('cli');
    }
  });

  it('routes memory.write through the registry and persists the row', async () => {
    const app = await newApp();
    const write = app.registry.get('memory.write');
    expect(write).toBeDefined();
    if (!write) return;

    const result = await executeCommand(write, { ...baseWriteInput, content: 'hello world' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await app.memoryRepository.read(result.value.id);
    expect(stored).not.toBeNull();
    expect(stored?.content).toBe('hello world');
  });

  it('fires the conflict hook post-write and attributes events to the writer', async () => {
    const app = await newApp();
    const write = app.registry.get('memory.write');
    if (!write) throw new Error('memory.write missing');

    const namedCtx = { actor: { type: 'cli' } as ActorRef };
    // The `fact` policy needs a negation flip plus token
    // overlap >= `conflict.fact.overlapThreshold` (default 3).
    // The two contents share `production`, `database`, `config`,
    // `points`/`point`, and `staging` tokens (>= 3) and one
    // leads with `not`, satisfying the asymmetric-negation
    // requirement.
    const a = await executeCommand(
      write,
      {
        ...baseWriteInput,
        content: 'production database config points to staging cluster',
      },
      namedCtx,
    );
    expect(a.ok).toBe(true);
    const b = await executeCommand(
      write,
      {
        ...baseWriteInput,
        content: 'not the production database config points to staging cluster',
      },
      namedCtx,
    );
    expect(b.ok).toBe(true);

    // The hook is fire-and-forget; the detection promise
    // resolves on the microtask queue. Poll briefly until it
    // finishes, with a hard cap so a regression fails fast
    // instead of hanging.
    const deadline = Date.now() + 1_000;
    let open = await app.conflictRepository.list({ open: true });
    while (open.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      open = await app.conflictRepository.list({ open: true });
    }
    expect(open.length).toBeGreaterThan(0);
  });

  it('close() is idempotent', async () => {
    const app = await newApp();
    expect(() => {
      app.close();
      app.close();
      app.close();
    }).not.toThrow();
  });

  it('honors a pre-opened database handle (does not close it)', async () => {
    const { openDatabase } = await import('../src/storage/database.js');
    const handle = openDatabase({ path: ':memory:' });
    let closed = false;
    const wrapped = {
      ...handle,
      close: () => {
        closed = true;
        handle.close();
      },
    };
    const app = await createMementoApp({ database: wrapped });
    app.close();
    expect(closed).toBe(false);
    handle.close();
  });
  it('drives the write-path scrubber from the scrubber.rules config key', async () => {
    // Override the rule set with a single deterministic rule so
    // the assertion does not depend on the shipped defaults; the
    // point is to pin that bootstrap routes the override through
    // to the repository, not to retest the engine.
    const app = await newApp({
      configOverrides: {
        'scrubber.rules': [
          {
            id: 'test.token',
            description: 'test fixture token',
            pattern: 'TOPSECRET-[A-Z0-9]+',
            placeholder: '<redacted:{{rule.id}}>',
            severity: 'high',
          },
        ],
      },
    });
    const write = app.registry.get('memory.write');
    if (!write) throw new Error('memory.write missing');
    const result = await executeCommand(
      write,
      { ...baseWriteInput, content: 'leak: TOPSECRET-ABC123 trailing' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await app.memoryRepository.read(result.value.id);
    expect(stored?.content).toBe('leak: <redacted:test.token> trailing');
  });

  it('disables redaction when scrubber.enabled is false', async () => {
    const app = await newApp({
      configOverrides: { 'scrubber.enabled': false },
    });
    const write = app.registry.get('memory.write');
    if (!write) throw new Error('memory.write missing');
    // The shipped `openai-api-key` rule would otherwise redact
    // this content; with the master toggle off the write must
    // pass through unchanged.
    const content = 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const result = await executeCommand(write, { ...baseWriteInput, content }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await app.memoryRepository.read(result.value.id);
    expect(stored?.content).toBe(content);
  });

  it('auto-embeds a memory on write when embeddingProvider is supplied and autoEmbed is true', async () => {
    const embeds: string[] = [];
    const provider: EmbeddingProvider = {
      model: 'test-embed-model',
      dimension: 3,
      embed: async (text: string) => {
        embeds.push(text);
        return [0.1, 0.2, 0.3];
      },
    };
    const app = await newApp({
      embeddingProvider: provider,
      configOverrides: { 'embedding.autoEmbed': true },
    });
    const write = app.registry.get('memory.write');
    if (!write) throw new Error('memory.write missing');

    const result = await executeCommand(
      write,
      { ...baseWriteInput, content: 'embed me please' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The hook is fire-and-forget; poll briefly until it completes.
    const deadline = Date.now() + 1_000;
    let stored = await app.memoryRepository.read(result.value.id);
    while (stored?.embedding === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored = await app.memoryRepository.read(result.value.id);
    }
    expect(stored?.embedding).not.toBeNull();
    expect(stored?.embedding?.model).toBe('test-embed-model');
    expect(stored?.embedding?.dimension).toBe(3);
    expect(stored?.embedding?.vector).toEqual([0.1, 0.2, 0.3]);
    expect(embeds).toContain('embed me please');
  });

  it('does not auto-embed when embedding.autoEmbed is false', async () => {
    const embeds: string[] = [];
    const provider: EmbeddingProvider = {
      model: 'test-embed-model',
      dimension: 3,
      embed: async (text: string) => {
        embeds.push(text);
        return [0.1, 0.2, 0.3];
      },
    };
    const app = await newApp({
      embeddingProvider: provider,
      configOverrides: { 'embedding.autoEmbed': false },
    });
    const write = app.registry.get('memory.write');
    if (!write) throw new Error('memory.write missing');

    const result = await executeCommand(
      write,
      { ...baseWriteInput, content: 'should not embed' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Give a tick for any stray async to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await app.memoryRepository.read(result.value.id);
    expect(stored?.embedding).toBeNull();
    expect(embeds).not.toContain('should not embed');
  });

  it('auto-embeds via the extract command afterWrite hook', async () => {
    const embeds: string[] = [];
    const provider: EmbeddingProvider = {
      model: 'test-embed-model',
      dimension: 3,
      embed: async (text: string) => {
        embeds.push(text);
        return [0.4, 0.5, 0.6];
      },
    };
    const app = await newApp({
      embeddingProvider: provider,
      configOverrides: { 'embedding.autoEmbed': true, 'extraction.processing': 'sync' },
    });
    const extract = app.registry.get('memory.extract');
    if (!extract) throw new Error('memory.extract missing');

    const result = await executeCommand(
      extract,
      {
        candidates: [{ kind: 'fact', content: 'extracted fact for embed test' }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Poll for the embedding to land.
    const written = (result.value as { written: Array<{ id: string }> }).written;
    expect(written.length).toBe(1);
    const memId = written[0]?.id as unknown as Parameters<typeof app.memoryRepository.read>[0];
    if (!memId) throw new Error('no written memory id');

    const deadline = Date.now() + 1_000;
    let stored = await app.memoryRepository.read(memId);
    while (stored?.embedding === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored = await app.memoryRepository.read(memId);
    }
    expect(stored?.embedding).not.toBeNull();
    expect(stored?.embedding?.model).toBe('test-embed-model');
    expect(stored?.embedding?.vector).toEqual([0.4, 0.5, 0.6]);
    expect(embeds).toContain('extracted fact for embed test');
  });

  it('swallows embedding errors gracefully (memory still persisted)', async () => {
    const provider: EmbeddingProvider = {
      model: 'broken-model',
      dimension: 3,
      embed: async () => {
        throw new Error('embedding service unavailable');
      },
    };
    const app = await newApp({
      embeddingProvider: provider,
      configOverrides: { 'embedding.autoEmbed': true },
    });
    const write = app.registry.get('memory.write');
    if (!write) throw new Error('memory.write missing');

    const result = await executeCommand(
      write,
      { ...baseWriteInput, content: 'embed will fail' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Give the async hook time to run and fail.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stored = await app.memoryRepository.read(result.value.id);
    // Memory persisted but embedding remains null.
    expect(stored?.content).toBe('embed will fail');
    expect(stored?.embedding).toBeNull();
  });
});

// — Startup embedding backfill (ADR-0021) ——————————————————————
//
// Bootstrap kicks off a bounded `reembedAll` pass at boot when
// an embedder is wired. These tests pin three things:
//
//   1. The pass actually runs (drains rows whose vector is
//      missing or stale relative to the configured embedder).
//   2. It is bounded by `embedding.startupBackfill.maxRows`.
//   3. It is gated by `embedding.startupBackfill.enabled` and
//      by the presence of an embedder.

describe('createMementoApp — startup embedding backfill', () => {
  // Build a backfill provider that hands back a deterministic
  // 3-vector. We track every embed/embedBatch invocation so a
  // test can assert the backfill *did* fire.
  function makeProvider(): {
    provider: EmbeddingProvider;
    embedCalls: () => number;
    batchCalls: () => number;
    totalTexts: () => number;
  } {
    let embed = 0;
    let batch = 0;
    let texts = 0;
    return {
      provider: {
        model: 'startup-backfill-test',
        dimension: 3,
        embed: async () => {
          embed += 1;
          return [0.1, 0.2, 0.3];
        },
        embedBatch: async (ts) => {
          batch += 1;
          texts += ts.length;
          return ts.map(() => [0.1, 0.2, 0.3] as readonly number[]);
        },
      },
      embedCalls: () => embed,
      batchCalls: () => batch,
      totalTexts: () => texts,
    };
  }

  // The backfill runs off-thread (kicked off from bootstrap
  // and not awaited by createMementoApp). Tests poll the DB
  // for vectors to land instead of relying on a fixed delay.
  async function waitForVectors(
    app: MementoApp,
    expected: number,
    deadlineMs = 1500,
  ): Promise<number> {
    const deadline = Date.now() + deadlineMs;
    let count = 0;
    while (Date.now() < deadline) {
      const memories = await app.memoryRepository.list({ status: 'active' });
      count = memories.filter((m) => m.embedding !== null).length;
      if (count >= expected) return count;
      await new Promise((r) => setTimeout(r, 10));
    }
    return count;
  }

  it('drains pending embeddings at boot when an embedder is wired and enabled', async () => {
    // Phase 1: write a memory with autoEmbed off — so it
    // lands without a vector. Then reopen the same DB with
    // autoEmbed AND startupBackfill enabled; the backfill
    // should fill in the vector.
    const phase1Provider = makeProvider();
    const app1 = await newApp({
      embeddingProvider: phase1Provider.provider,
      configOverrides: { 'embedding.autoEmbed': false },
    });
    const writeResult = await executeCommand(
      app1.registry.get('memory.write')!,
      { ...baseWriteInput, content: 'orphan-from-prev-session' },
      ctx,
    );
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) return;
    const orphanId = writeResult.value.id;
    // Sanity: no vector landed (autoEmbed off).
    expect((await app1.memoryRepository.read(orphanId))?.embedding).toBeNull();

    // Close phase-1 app but keep the SQLite handle alive for
    // phase 2 to adopt. (`:memory:` is per-handle, so we have
    // to share the database handle across the two apps.)
    const sharedDb = app1.db;
    apps.pop(); // remove from afterEach close list — phase 2 will close
    // Don't actually close — phase 2 adopts.

    // Phase 2: reopen with the same DB handle, an embedder, and
    // startup backfill enabled. The backfill should fire and
    // populate the orphan's vector.
    const phase2Provider = makeProvider();
    const app2 = await createMementoApp({
      database: sharedDb,
      embeddingProvider: phase2Provider.provider,
      configOverrides: {
        'embedding.startupBackfill.enabled': true,
      },
    });
    apps.push(app2);
    const landed = await waitForVectors(app2, 1);
    expect(landed).toBe(1);
    // The provider's embedBatch was invoked at least once.
    expect(phase2Provider.batchCalls() + phase2Provider.embedCalls()).toBeGreaterThan(0);
    const refreshed = await app2.memoryRepository.read(orphanId);
    expect(refreshed?.embedding).not.toBeNull();
    expect(refreshed?.embedding?.model).toBe('startup-backfill-test');
  });

  it('does not run startup backfill when embedding.startupBackfill.enabled is false', async () => {
    const provider = makeProvider();
    const app1 = await newApp({
      embeddingProvider: provider.provider,
      configOverrides: { 'embedding.autoEmbed': false },
    });
    const writeResult = await executeCommand(
      app1.registry.get('memory.write')!,
      { ...baseWriteInput, content: 'no-backfill-please' },
      ctx,
    );
    expect(writeResult.ok).toBe(true);
    const sharedDb = app1.db;
    apps.pop();

    const provider2 = makeProvider();
    const app2 = await createMementoApp({
      database: sharedDb,
      embeddingProvider: provider2.provider,
      configOverrides: {
        'embedding.startupBackfill.enabled': false,
      },
    });
    apps.push(app2);

    // Wait a beat to be sure the backfill task — if there
    // were one — would have fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(provider2.batchCalls()).toBe(0);
    expect(provider2.embedCalls()).toBe(0);
    const memories = await app2.memoryRepository.list({ status: 'active' });
    expect(memories.every((m) => m.embedding === null)).toBe(true);
  });

  it('does not run startup backfill when no embedder is wired (vector retrieval off)', async () => {
    // Seed phase: same DB, write a memory.
    const provider = makeProvider();
    const app1 = await newApp({
      embeddingProvider: provider.provider,
      configOverrides: { 'embedding.autoEmbed': false },
    });
    await executeCommand(
      app1.registry.get('memory.write')!,
      { ...baseWriteInput, content: 'no-embedder-this-time' },
      ctx,
    );
    const sharedDb = app1.db;
    apps.pop();

    // Reopen WITHOUT an embedder. The startup-backfill check
    // shortcircuits before touching anything.
    const app2 = await createMementoApp({
      database: sharedDb,
      configOverrides: {
        'embedding.startupBackfill.enabled': true,
      },
    });
    apps.push(app2);

    await new Promise((r) => setTimeout(r, 50));
    const memories = await app2.memoryRepository.list({ status: 'active' });
    expect(memories.every((m) => m.embedding === null)).toBe(true);
  });

  it('respects the maxRows cap (writes only up to the configured number)', async () => {
    // Seed 5 orphan memories with autoEmbed off.
    const provider1 = makeProvider();
    const app1 = await newApp({
      embeddingProvider: provider1.provider,
      configOverrides: { 'embedding.autoEmbed': false },
    });
    for (let i = 0; i < 5; i += 1) {
      await executeCommand(
        app1.registry.get('memory.write')!,
        { ...baseWriteInput, content: `orphan-${i}` },
        ctx,
      );
    }
    const sharedDb = app1.db;
    apps.pop();

    // Reopen with a maxRows cap of 2. The backfill scans 2
    // and stops; the other 3 stay pending until the next boot
    // or an explicit `embedding.rebuild`.
    const provider2 = makeProvider();
    const app2 = await createMementoApp({
      database: sharedDb,
      embeddingProvider: provider2.provider,
      configOverrides: {
        'embedding.startupBackfill.enabled': true,
        'embedding.startupBackfill.maxRows': 2,
      },
    });
    apps.push(app2);
    const landed = await waitForVectors(app2, 2);
    expect(landed).toBe(2);
    // Wait a beat past the deadline-window to ensure no
    // additional embeds slip in.
    await new Promise((r) => setTimeout(r, 100));
    const memories = await app2.memoryRepository.list({ status: 'active' });
    const withVectors = memories.filter((m) => m.embedding !== null);
    expect(withVectors).toHaveLength(2);
  });
});

describe('createMementoApp — embedder warmup', () => {
  function makeProviderWithWarmup(): {
    provider: EmbeddingProvider;
    warmupCalls: () => number;
  } {
    let warmup = 0;
    return {
      provider: {
        model: 'warmup-test',
        dimension: 3,
        embed: async () => [0.1, 0.2, 0.3],
        warmup: async () => {
          warmup += 1;
        },
      },
      warmupCalls: () => warmup,
    };
  }

  it('fires provider.warmup() at boot when embedder.local.warmupOnBoot is true', async () => {
    const { provider, warmupCalls } = makeProviderWithWarmup();
    await newApp({ embeddingProvider: provider });
    // Fire-and-forget — the warmup promise has resolved by now
    // because the fake completes synchronously, but yield once
    // to let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(warmupCalls()).toBe(1);
  });

  it('skips warmup when embedder.local.warmupOnBoot is false', async () => {
    const { provider, warmupCalls } = makeProviderWithWarmup();
    await newApp({
      embeddingProvider: provider,
      configOverrides: { 'embedder.local.warmupOnBoot': false },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(warmupCalls()).toBe(0);
  });

  it('is a no-op when the provider does not expose warmup', async () => {
    // A provider missing the optional method must not break boot.
    const provider: EmbeddingProvider = {
      model: 'no-warmup',
      dimension: 3,
      embed: async () => [0, 0, 0],
    };
    const app = await newApp({ embeddingProvider: provider });
    expect(app).toBeDefined();
  });

  it('does not block boot or rethrow when warmup rejects', async () => {
    // The provider's warmup throws — bootstrap must swallow it
    // and return a usable app. The next real embed surfaces any
    // underlying error.
    const failing: EmbeddingProvider = {
      model: 'rejecting-warmup',
      dimension: 3,
      embed: async () => [0, 0, 0],
      warmup: async () => {
        throw new Error('boom');
      },
    };
    const app = await newApp({ embeddingProvider: failing });
    await new Promise((r) => setTimeout(r, 10));
    expect(app).toBeDefined();
  });
});

// — Graceful shutdown ——————————————————————————————————————————
//
// `createMementoApp` kicks off four classes of fire-and-forget work
// — the startup backfill (ADR-0021), the embedder warmup, post-write
// conflict hooks (ADR-0005), and post-write auto-embed. Any of them
// can leave an in-flight ONNX inference (or model load) when a
// signal-driven host (`memento dashboard`, `memento serve`) tears
// down on Ctrl-C. Tearing down the embedder's native worker threads
// mid-flight aborts the process with `libc++abi: mutex lock failed:
// Invalid argument`. `MementoApp.shutdown()` drains the lot through
// a single `pendingBackgroundWork` tracker (ADR-0024 generalises
// ADR-0023) before running the synchronous close.
//
// Pinning the observable properties:
//
//   1. Shutdown waits for an in-flight backfill before closing.
//   2. Shutdown returns within the configured grace window even
//      when the backfill is stuck (never resolves).
//   3. Shutdown is idempotent.
//   4. Shutdown is a no-op (effectively instant) when no background
//      work was kicked off (no embedder, all knobs off).
//   5. Shutdown waits for the embedder warmup — the exact path that
//      reproduces the libc++ crash on an empty-store dashboard
//      session, where there is nothing to backfill but the warmup
//      is still loading the ONNX pipeline.
//   6. Shutdown waits for in-flight post-write auto-embed — covers
//      the case where the user writes a memory and Ctrl-Cs before
//      the embed call has returned.

describe('createMementoApp — graceful shutdown', () => {
  it('awaits the in-flight startup backfill before closing the database', async () => {
    // Phase 1: write an orphan with autoEmbed off so the row
    // lands without a vector.
    const phase1Provider: EmbeddingProvider = {
      model: 'shutdown-await-test',
      dimension: 3,
      embed: async () => [0.1, 0.2, 0.3],
    };
    const app1 = await newApp({
      embeddingProvider: phase1Provider,
      configOverrides: { 'embedding.autoEmbed': false },
    });
    const writeResult = await executeCommand(
      app1.registry.get('memory.write')!,
      { ...baseWriteInput, content: 'shutdown-await-orphan' },
      ctx,
    );
    expect(writeResult.ok).toBe(true);
    const sharedDb = app1.db;
    apps.pop();

    // Phase 2: embedBatch returns a promise the test controls.
    // The backfill enters embedBatch and parks until we release.
    let releaseBatch: () => void = () => {};
    const blockingProvider: EmbeddingProvider = {
      model: 'shutdown-await-test',
      dimension: 3,
      embed: async () => [0.1, 0.2, 0.3],
      embedBatch: (ts) =>
        new Promise((resolve) => {
          releaseBatch = () => resolve(ts.map(() => [0.1, 0.2, 0.3] as readonly number[]));
        }),
    };
    const app2 = await createMementoApp({
      database: sharedDb,
      embeddingProvider: blockingProvider,
      configOverrides: {
        'embedding.startupBackfill.enabled': true,
        'embedding.startupBackfill.shutdownGraceMs': 5000,
      },
    });
    apps.push(app2);

    // Race shutdown against a probe that flips after a short
    // yield. If shutdown resolves before the probe fires, the
    // grace window is being ignored and the test fails loud.
    let shutdownResolved = false;
    const shutdownPromise = app2.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(shutdownResolved).toBe(false);

    // Release the batch — backfill resolves — shutdown completes.
    releaseBatch();
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  it('returns within the configured grace window when the backfill is stuck', async () => {
    // Phase 1: seed an orphan.
    const phase1Provider: EmbeddingProvider = {
      model: 'shutdown-timeout-test',
      dimension: 3,
      embed: async () => [0.1, 0.2, 0.3],
    };
    const app1 = await newApp({
      embeddingProvider: phase1Provider,
      configOverrides: { 'embedding.autoEmbed': false },
    });
    await executeCommand(
      app1.registry.get('memory.write')!,
      { ...baseWriteInput, content: 'shutdown-timeout-orphan' },
      ctx,
    );
    const sharedDb = app1.db;
    apps.pop();

    // Phase 2: embedBatch never resolves. Without the grace
    // window, shutdown would hang forever; with it, shutdown
    // returns after roughly graceMs.
    const stuckProvider: EmbeddingProvider = {
      model: 'shutdown-timeout-test',
      dimension: 3,
      embed: () => new Promise<readonly number[]>(() => {}),
      embedBatch: () => new Promise<readonly (readonly number[])[]>(() => {}),
    };
    const app2 = await createMementoApp({
      database: sharedDb,
      embeddingProvider: stuckProvider,
      configOverrides: {
        'embedding.startupBackfill.enabled': true,
        'embedding.startupBackfill.shutdownGraceMs': 50,
      },
    });
    apps.push(app2);

    const start = Date.now();
    await app2.shutdown();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(50);
    // Generous upper bound so a slow CI box doesn't flake.
    expect(elapsed).toBeLessThan(2000);
  });

  it('is idempotent — second shutdown is a no-op', async () => {
    const app = await newApp();
    await app.shutdown();
    // Second call must not throw and must resolve.
    await app.shutdown();
  });

  it('is effectively instant when no background work was kicked off', async () => {
    // No embedder → bootstrap shortcircuits backfill, warmup, and
    // auto-embed all at once → tracker is empty → shutdown skips
    // the await entirely and runs close synchronously.
    const app = await newApp();
    apps.pop(); // shutdown will close; afterEach would double-close.
    const start = Date.now();
    await app.shutdown();
    const elapsed = Date.now() - start;
    // No await, so this should complete in microtask time. 50ms
    // is overhead the test environment introduces.
    expect(elapsed).toBeLessThan(50);
  });

  it('awaits the in-flight embedder warmup before closing the database', async () => {
    // The exact path that reproduces the libc++ crash on
    // `memento dashboard` against an empty store: backfill is a
    // no-op (nothing to embed), warmup is the only thing in flight,
    // and tearing down the embedder mid-load aborts the process.
    // This test pins the warmup branch of the tracker.
    let releaseWarmup: () => void = () => {};
    const blockingProvider: EmbeddingProvider = {
      model: 'shutdown-await-warmup',
      dimension: 3,
      embed: async () => [0.1, 0.2, 0.3],
      warmup: () =>
        new Promise<void>((resolve) => {
          releaseWarmup = resolve;
        }),
    };
    const app = await newApp({
      embeddingProvider: blockingProvider,
      configOverrides: {
        'embedder.local.warmupOnBoot': true,
        'embedding.startupBackfill.enabled': false,
        'embedding.autoEmbed': false,
        'embedding.startupBackfill.shutdownGraceMs': 5000,
      },
    });
    apps.pop();

    // Yield so the warmup gets a chance to enter and register
    // with the tracker.
    await new Promise((r) => setTimeout(r, 20));

    let shutdownResolved = false;
    const shutdownPromise = app.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(shutdownResolved).toBe(false);

    // Release the warmup — tracker drains — shutdown completes.
    releaseWarmup();
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  it('awaits in-flight post-write auto-embed before closing the database', async () => {
    // Covers the write-then-Ctrl-C race: a user writes a memory,
    // the post-write auto-embed kicks off, the user hits Ctrl-C
    // before the embed call has returned. Without tracking the
    // promise, shutdown closes the database while the embedder
    // still has work in flight.
    let releaseEmbed: () => void = () => {};
    const blockingProvider: EmbeddingProvider = {
      model: 'shutdown-await-autoembed',
      dimension: 3,
      embed: () =>
        new Promise<readonly number[]>((resolve) => {
          releaseEmbed = () => resolve([0.1, 0.2, 0.3]);
        }),
    };
    const app = await newApp({
      embeddingProvider: blockingProvider,
      configOverrides: {
        'embedding.autoEmbed': true,
        'embedder.local.warmupOnBoot': false,
        'embedding.startupBackfill.enabled': false,
        'embedding.startupBackfill.shutdownGraceMs': 5000,
      },
    });
    apps.pop();

    // Write a memory — the post-write hook fires fire-and-forget
    // and registers with the tracker.
    const writeResult = await executeCommand(
      app.registry.get('memory.write')!,
      { ...baseWriteInput, content: 'auto-embed-await-test' },
      ctx,
    );
    expect(writeResult.ok).toBe(true);

    // Yield so the auto-embed promise enters the tracker.
    await new Promise((r) => setTimeout(r, 20));

    let shutdownResolved = false;
    const shutdownPromise = app.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(shutdownResolved).toBe(false);

    releaseEmbed();
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });
});
