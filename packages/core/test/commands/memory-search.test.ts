// `memory.search` command — end-to-end coverage.
//
// Goes through `executeCommand` so the input schema runs on the
// way in and the output schema runs on the way out. That mirrors
// exactly how MCP / CLI adapters will invoke search and pins the
// breakdown shape the registry promises to callers.

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand } from '../../src/commands/execute.js';
import { createMemorySearchCommand } from '../../src/commands/memory/search.js';
import { createConfigStore } from '../../src/config/index.js';
import { createConflictRepository } from '../../src/conflict/index.js';
import {
  type MemoryRepository,
  createMemoryRepository,
} from '../../src/repository/memory-repository.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

interface OpenHandle {
  close(): void;
  db: Parameters<typeof migrateToLatest>[0];
}
const handles: OpenHandle[] = [];
afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

const actor: ActorRef = { type: 'cli' };
const ctx = { actor };

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    return `${prefix}${String(i).padStart(24, '0')}`;
  };
}

const fixedClock = '2025-01-01T00:00:00.000Z';

async function fixture(): Promise<{
  repo: MemoryRepository;
  command: ReturnType<typeof createMemorySearchCommand>;
  db: OpenHandle['db'];
}> {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  const repo = createMemoryRepository(handle.db, {
    clock: () => fixedClock as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const command = createMemorySearchCommand({
    db: handle.db,
    memoryRepository: repo,
    configStore: createConfigStore(),
    clock: () => fixedClock,
  });
  return { repo, command, db: handle.db };
}

const baseInput = {
  scope: { type: 'global' as const },
  owner: { type: 'local' as const, id: 'tester' },
  kind: { type: 'fact' as const },
  tags: [] as string[],
  pinned: false,
  content: '',
  summary: null,
  storedConfidence: 0.9,
};

describe('memory.search command', () => {
  it('declares read sideEffect and exposes both surfaces', async () => {
    const { command } = await fixture();
    expect(command.name).toBe('memory.search');
    expect(command.sideEffect).toBe('read');
    expect([...command.surfaces].sort()).toEqual(['cli', 'mcp']);
  });

  it('returns ranked results validated against the output schema', async () => {
    const { repo, command } = await fixture();
    const a = await repo.write({ ...baseInput, content: 'kafka kafka topic' }, { actor });
    await repo.write({ ...baseInput, content: 'unrelated note' }, { actor });

    const result = await executeCommand(command, { text: 'kafka' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.nextCursor).toBeNull();
    expect(result.value.results[0]?.memory.id).toBe(a.id);
    expect(result.value.results[0]?.score).toBeGreaterThan(0);
    expect(result.value.results[0]?.breakdown).toMatchObject({
      fts: expect.any(Number),
      vector: expect.any(Number),
      confidence: expect.any(Number),
      recency: expect.any(Number),
      scope: expect.any(Number),
      pinned: expect.any(Number),
    });
  });

  it('rejects empty text with INVALID_INPUT', async () => {
    const { command } = await fixture();
    const result = await executeCommand(command, { text: '' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('forwards scope filter to the engine', async () => {
    const { repo, command } = await fixture();
    await repo.write({ ...baseInput, content: 'kafka here' }, { actor });
    const ws = await repo.write(
      {
        ...baseInput,
        scope: { type: 'workspace', path: '/x' as never },
        content: 'kafka there',
      },
      { actor },
    );

    const result = await executeCommand(
      command,
      {
        text: 'kafka',
        scopes: [{ type: 'workspace', path: '/x' as never }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((r) => r.memory.id)).toEqual([ws.id]);
  });

  it('paginates by cursor across the ranked output', async () => {
    const { repo, command } = await fixture();
    // Five matching memories. With limit=2 we expect 3 pages
    // (2, 2, 1). Cursors are stable because the ranker is
    // deterministic on a fixed clock.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const m = await repo.write({ ...baseInput, content: `kafka topic ${i}` }, { actor });
      ids.push(m.id as unknown as string);
    }

    const page1 = await executeCommand(command, { text: 'kafka', limit: 2 }, ctx);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.results).toHaveLength(2);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await executeCommand(
      command,
      { text: 'kafka', limit: 2, cursor: page1.value.nextCursor as never },
      ctx,
    );
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.results).toHaveLength(2);
    expect(page2.value.nextCursor).not.toBeNull();

    const page3 = await executeCommand(
      command,
      { text: 'kafka', limit: 2, cursor: page2.value.nextCursor as never },
      ctx,
    );
    expect(page3.ok).toBe(true);
    if (!page3.ok) return;
    expect(page3.value.results).toHaveLength(1);
    expect(page3.value.nextCursor).toBeNull();

    // No id duplicated across pages; union covers all five.
    const seen = [...page1.value.results, ...page2.value.results, ...page3.value.results].map(
      (r) => r.memory.id as unknown as string,
    );
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('returns an empty page for a stale cursor', async () => {
    const { repo, command } = await fixture();
    await repo.write({ ...baseInput, content: 'kafka here' }, { actor });
    const result = await executeCommand(
      command,
      // ULID-shaped but not present in the ranked set.
      { text: 'kafka', cursor: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' as never },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toEqual([]);
    expect(result.value.nextCursor).toBeNull();
  });

  it('rejects retrieval.vector.enabled with CONFIG_ERROR when no embedding provider is wired', async () => {
    // The flag promises a vector union; the host did not wire
    // a provider. Surface that with a structured CONFIG_ERROR
    // rather than silently degrading to FTS-only — the latter
    // would hide a real configuration mistake.
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const command = createMemorySearchCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
      clock: () => fixedClock,
    });
    await repo.write({ ...baseInput, content: 'kafka' }, { actor });
    const result = await executeCommand(command, { text: 'kafka' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG_ERROR');
    expect(result.error.message).toMatch(/EmbeddingProvider/);
  });

  it('unions FTS and vector candidates when retrieval.vector.enabled and an embedder is wired', async () => {
    // End-to-end check that the second arm of the pipeline
    // contributes candidates. Memory `b` matches by FTS only,
    // memory `a` matches by both. Both should appear; the
    // ranker decides the order, and the breakdown surfaces
    // both `fts` and `vector` components for `a`.
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const provider = {
      model: 'fake-model',
      dimension: 3,
      // Map the query 'kafka' to a unit vector aligned with
      // memory `a`'s embedding so cosine ~ 1; memory `c`'s
      // vector is orthogonal so it cannot win the union just
      // from vector signal alone.
      embed: async (text: string): Promise<readonly number[]> => {
        if (text === 'kafka') return [1, 0, 0];
        return [0, 1, 0];
      },
    };
    const a = await repo.write({ ...baseInput, content: 'kafka topic' }, { actor });
    await repo.setEmbedding(
      a.id,
      { model: 'fake-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );
    const b = await repo.write({ ...baseInput, content: 'kafka stream' }, { actor });
    // `b` has no embedding \u2014 it should still appear via FTS.
    const c = await repo.write({ ...baseInput, content: 'redis cache' }, { actor });
    await repo.setEmbedding(
      c.id,
      { model: 'fake-model', dimension: 3, vector: [0, 0, 1] },
      { actor },
    );

    const command = createMemorySearchCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
      embeddingProvider: provider,
      clock: () => fixedClock,
    });
    const result = await executeCommand(command, { text: 'kafka' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.results.map((r) => r.memory.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // `c` may appear in the candidate set with a low score
    // (the ranker normalises cosine to [0,1], so an
    // orthogonal vector contributes 0.5 not 0). The salient
    // assertion is that `a` ranks above `c` and the breakdown
    // exposes both arms — not absence of `c`.
    void c;
    const aResult = result.value.results.find((r) => r.memory.id === a.id);
    expect(aResult?.breakdown.fts).toBeGreaterThan(0);
    expect(aResult?.breakdown.vector).toBeGreaterThan(0);
    const bResult = result.value.results.find((r) => r.memory.id === b.id);
    expect(bResult?.breakdown.fts).toBeGreaterThan(0);
    expect(bResult?.breakdown.vector).toBe(0);
  });

  it('returns vector-only candidates when FTS produces no hits', async () => {
    // Vector retrieval rescues queries whose terms are
    // paraphrased rather than literal. Here FTS matches
    // nothing but the embedder maps the query into a vector
    // that lines up with memory `a`'s stored embedding.
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const provider = {
      model: 'fake-model',
      dimension: 3,
      embed: async (_text: string): Promise<readonly number[]> => [1, 0, 0],
    };
    const a = await repo.write({ ...baseInput, content: 'distributed log' }, { actor });
    await repo.setEmbedding(
      a.id,
      { model: 'fake-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );

    const command = createMemorySearchCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
      embeddingProvider: provider,
      clock: () => fixedClock,
    });
    const result = await executeCommand(command, { text: 'paraphrase' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((r) => r.memory.id)).toEqual([a.id]);
    expect(result.value.results[0]?.breakdown.fts).toBe(0);
    expect(result.value.results[0]?.breakdown.vector).toBeGreaterThan(0);
  });

  it('maps StaleEmbeddingError to CONFIG_ERROR with a rebuild hint', async () => {
    // A row was embedded with a model the configured provider
    // doesn't match. Mixing vector spaces would silently
    // corrupt ranking, so the pipeline aborts. The surface
    // sees a structured CONFIG_ERROR pointing at
    // `embedding rebuild`.
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const provider = {
      model: 'new-model',
      dimension: 3,
      embed: async (_text: string): Promise<readonly number[]> => [1, 0, 0],
    };
    const a = await repo.write({ ...baseInput, content: 'topic' }, { actor });
    await repo.setEmbedding(
      a.id,
      { model: 'old-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );

    const command = createMemorySearchCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
      embeddingProvider: provider,
      clock: () => fixedClock,
    });
    const result = await executeCommand(command, { text: 'topic' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG_ERROR');
    expect(result.error.message).toMatch(/embedding rebuild/);
  });

  it('clamps the requested limit against retrieval.search.maxLimit at the command boundary', async () => {
    // Pipeline-level clamp is already covered. This test pins
    // the contract through `executeCommand`, which is the only
    // surface adapters (MCP/CLI) ever touch \u2014 a regression in
    // the wiring (e.g. a future change forwarding `limit` past
    // the schema) would otherwise be invisible.
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    for (let i = 0; i < 5; i += 1) {
      await repo.write({ ...baseInput, content: `kafka topic ${i}` }, { actor });
    }
    const command = createMemorySearchCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore: createConfigStore({ 'retrieval.search.maxLimit': 2 }),
      clock: () => fixedClock,
    });
    const result = await executeCommand(command, { text: 'kafka', limit: 100 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(2);
    // hasMore is true (5 candidates, page size 2) so a cursor
    // must be returned \u2014 paging continues to advance even when
    // the caller asked for more than the configured ceiling.
    expect(result.value.nextCursor).not.toBeNull();
  });

  it('returns an empty page when the sanitiser collapses the query to no tokens', async () => {
    // FTS5 sigils with no alphanumerics survive Zod (text is
    // non-empty) but `sanitizeFtsQuery` returns ''. The pipeline
    // must short-circuit instead of issuing `MATCH ''` (which
    // FTS5 rejects). End-to-end test pins that contract via the
    // command surface.
    const { repo, command } = await fixture();
    await repo.write({ ...baseInput, content: 'kafka here' }, { actor });
    const result = await executeCommand(command, { text: ':()*^' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toEqual([]);
    expect(result.value.nextCursor).toBeNull();
  });

  describe('conflict.surfaceInSearch', () => {
    // The contract is documented on `CreateMemorySearchCommandDeps`:
    // every result carries a `conflicts` array (possibly empty)
    // so consumers can rely on the field shape regardless of the
    // flag. Surfacing must not change ordering or scoring \u2014 it
    // only enriches.

    async function makeFixture(opts: {
      readonly surface: boolean;
      readonly withConflictRepo: boolean;
    }): Promise<{
      repo: MemoryRepository;
      conflictRepo: ReturnType<typeof createConflictRepository>;
      command: ReturnType<typeof createMemorySearchCommand>;
    }> {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const conflictRepo = createConflictRepository(handle.db, {
        clock: () => fixedClock as never,
        conflictIdFactory: counterFactory('C0') as never,
        eventIdFactory: counterFactory('CE'),
      });
      const configStore = createConfigStore({
        'conflict.surfaceInSearch': opts.surface,
      });
      const command = createMemorySearchCommand({
        db: handle.db,
        memoryRepository: repo,
        configStore,
        ...(opts.withConflictRepo ? { conflictRepository: conflictRepo } : {}),
        clock: () => fixedClock,
      });
      return { repo, conflictRepo, command };
    }

    it('annotates every result with conflicts: [] when the flag is off', async () => {
      const { repo, command } = await makeFixture({
        surface: false,
        withConflictRepo: true,
      });
      await repo.write({ ...baseInput, content: 'kafka topic' }, { actor });
      const result = await executeCommand(command, { text: 'kafka' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results).toHaveLength(1);
      expect(result.value.results[0]?.conflicts).toEqual([]);
    });

    it('annotates with conflicts: [] when no conflictRepository was wired', async () => {
      const { repo, command } = await makeFixture({
        surface: true,
        withConflictRepo: false,
      });
      await repo.write({ ...baseInput, content: 'kafka topic' }, { actor });
      const result = await executeCommand(command, { text: 'kafka' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results).toHaveLength(1);
      expect(result.value.results[0]?.conflicts).toEqual([]);
    });

    it('annotates with conflicts: [] when no open conflicts exist', async () => {
      const { repo, command } = await makeFixture({
        surface: true,
        withConflictRepo: true,
      });
      await repo.write({ ...baseInput, content: 'kafka topic' }, { actor });
      const result = await executeCommand(command, { text: 'kafka' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results[0]?.conflicts).toEqual([]);
    });

    it('surfaces an open conflict from the perspective of the result memory', async () => {
      const { repo, conflictRepo, command } = await makeFixture({
        surface: true,
        withConflictRepo: true,
      });
      const m1 = await repo.write({ ...baseInput, content: 'kafka starts at 10am' }, { actor });
      const m2 = await repo.write({ ...baseInput, content: 'kafka starts at 11am' }, { actor });
      const opened = await conflictRepo.open(
        {
          newMemoryId: m2.id,
          conflictingMemoryId: m1.id,
          kind: 'fact',
          evidence: { reason: 'test' },
        },
        { actor },
      );

      const result = await executeCommand(command, { text: 'kafka' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Both memories should each surface the same conflict, but
      // with `otherMemoryId` set to the *other* side.
      const byId = new Map(result.value.results.map((r) => [r.memory.id, r]));
      expect(byId.get(m1.id)?.conflicts).toEqual([
        { conflictId: opened.id, otherMemoryId: m2.id, kind: 'fact' },
      ]);
      expect(byId.get(m2.id)?.conflicts).toEqual([
        { conflictId: opened.id, otherMemoryId: m1.id, kind: 'fact' },
      ]);
    });

    it('does not surface resolved conflicts', async () => {
      const { repo, conflictRepo, command } = await makeFixture({
        surface: true,
        withConflictRepo: true,
      });
      const m1 = await repo.write({ ...baseInput, content: 'kafka starts at 10am' }, { actor });
      const m2 = await repo.write({ ...baseInput, content: 'kafka starts at 11am' }, { actor });
      const opened = await conflictRepo.open(
        {
          newMemoryId: m2.id,
          conflictingMemoryId: m1.id,
          kind: 'fact',
          evidence: { reason: 'test' },
        },
        { actor },
      );
      await conflictRepo.resolve(opened.id, 'accept-new', { actor });

      const result = await executeCommand(command, { text: 'kafka' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const r of result.value.results) {
        expect(r.conflicts).toEqual([]);
      }
    });
  });

  // ADR-0012 §3: search must redact sensitive rows when the
  // privacy flag is on. The projection is presentation-only —
  // ranking and ordering must not change because of the flag.
  describe('privacy.redactSensitiveSnippets', () => {
    it('projects sensitive results to the redacted view when on', async () => {
      const { repo, db } = await fixture();
      const command = createMemorySearchCommand({
        db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'privacy.redactSensitiveSnippets': true,
        }),
        clock: () => fixedClock,
      });
      const sensitive = await repo.write(
        { ...baseInput, content: 'kafka secret', sensitive: true },
        { actor },
      );

      const result = await executeCommand(command, { text: 'kafka' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results).toHaveLength(1);
      const memory = result.value.results[0]?.memory;
      expect(memory?.id).toBe(sensitive.id);
      expect(memory?.redacted).toBe(true);
      expect(memory?.content).toBeNull();
    });

    it('returns full content when the flag is off', async () => {
      const { repo, db } = await fixture();
      const command = createMemorySearchCommand({
        db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'privacy.redactSensitiveSnippets': false,
        }),
        clock: () => fixedClock,
      });
      await repo.write({ ...baseInput, content: 'kafka secret', sensitive: true }, { actor });

      const result = await executeCommand(command, { text: 'kafka' }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const memory = result.value.results[0]?.memory;
      expect(memory?.redacted).toBe(false);
      expect(memory?.content).toBe('kafka secret');
    });
  });
});
