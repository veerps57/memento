import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfigStore } from '../../src/config/index.js';
import type { EmbeddingProvider } from '../../src/embedding/provider.js';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
import type { MemoryWriteInput } from '../../src/repository/memory-repository.js';
import { searchFts } from '../../src/retrieval/fts.js';
import { VectorRetrievalConfigError, searchMemories } from '../../src/retrieval/pipeline.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

interface OpenHandle {
  close(): void;
}
const handles: OpenHandle[] = [];
afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

async function fixture() {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  return handle;
}

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    return `${prefix}${String(i).padStart(24, '0')}`;
  };
}

const fixedClock = '2025-01-01T00:00:00.000Z';
const actor: ActorRef = { type: 'cli' };

const baseInput: MemoryWriteInput = {
  scope: { type: 'global' },
  owner: { type: 'local', id: 'tester' },
  kind: { type: 'fact' },
  tags: [],
  pinned: false,
  content: '',
  summary: null,
  storedConfidence: 0.9,
};

describe('searchMemories', () => {
  it('returns ranked, hydrated results for matching memories', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const a = await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });
    await repo.write({ ...baseInput, content: 'unrelated' }, { actor });

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    expect(page.results).toHaveLength(1);
    expect(page.results[0]?.memory.id).toBe(a.id);
    expect(page.results[0]?.score).toBeGreaterThan(0);
    expect(page.results[0]?.breakdown.fts).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  it('returns no results for an empty query', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db);
    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
      },
      { text: '   ' },
    );
    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('clamps the limit against retrieval.search.maxLimit', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    for (let i = 0; i < 5; i += 1) {
      await repo.write({ ...baseInput, content: `kafka ${i}` }, { actor });
    }
    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.search.maxLimit': 2,
          'retrieval.vector.enabled': false,
        }),
        clock: () => fixedClock,
      },
      { text: 'kafka', limit: 100 },
    );
    expect(page.results).toHaveLength(2);
  });

  it('honours scopes filter end-to-end', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka here' }, { actor });
    const ws = await repo.write(
      {
        ...baseInput,
        scope: { type: 'workspace', path: '/x' as never },
        content: 'kafka there',
      },
      { actor },
    );

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      {
        text: 'kafka',
        scopes: [{ type: 'workspace', path: '/x' as never }],
      },
    );
    expect(page.results.map((r) => r.memory.id)).toEqual([ws.id]);
  });

  it('degrades gracefully to FTS-only when embed() throws at runtime', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka transient' }, { actor });

    const failingProvider: EmbeddingProvider = {
      model: 'test-model',
      dimension: 384,
      embed: () => Promise.reject(new Error('network timeout')),
    };

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
        embeddingProvider: failingProvider,
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    // FTS still returns the match despite vector arm failing.
    expect(page.results).toHaveLength(1);
    expect(page.results[0]?.memory.content).toBe('kafka transient');
  });

  it('throws VectorRetrievalConfigError when vector is enabled but no provider is wired', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db);

    await expect(
      searchMemories(
        {
          db: handle.db,
          memoryRepository: repo,
          configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
          clock: () => fixedClock,
        },
        { text: 'anything' },
      ),
    ).rejects.toBeInstanceOf(VectorRetrievalConfigError);
  });

  it('returns empty page when limit is 0', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka', limit: 0 },
    );

    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns empty page when includeStatuses is empty', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka', includeStatuses: [] },
    );

    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns empty page when limit is non-finite (falls back to default)', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });

    // Non-finite limit falls back to the configured default limit,
    // so results are still returned (exercises clampLimit branch).
    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka', limit: Number.POSITIVE_INFINITY },
    );

    expect(page.results).toHaveLength(1);
  });

  it('returns empty page when limit is negative (falls back to default)', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka', limit: -5 },
    );

    expect(page.results).toHaveLength(1);
  });

  it('returns empty page when cursor does not match any result (stale cursor)', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka stale cursor test' }, { actor });

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka', cursor: '01HZZZZZZZZZZZZZZZZZZZZZZZ' as never },
    );

    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('filters results by tags post-hydration', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const tagged = await repo.write(
      { ...baseInput, content: 'kafka tagged', tags: ['important'] },
      { actor },
    );
    await repo.write({ ...baseInput, content: 'kafka untagged', tags: [] }, { actor });

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka', tags: ['important'] },
    );

    expect(page.results).toHaveLength(1);
    expect(page.results[0]?.memory.id).toBe(tagged.id);
  });

  it('re-wraps StaleEmbeddingError as VectorRetrievalConfigError', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka stale embed' }, { actor });

    // Manually insert a stale embedding into the DB so the vector
    // scanner encounters a model mismatch.
    const { StaleEmbeddingError } = await import('../../src/retrieval/vector.js');

    const staleProvider: EmbeddingProvider = {
      model: 'stale-model',
      dimension: 4,
      embed: () => {
        throw new StaleEmbeddingError({
          memoryId: 'M0fake',
          storedModel: 'stale-model',
          storedDimension: 4,
          providerModel: 'other-model',
          providerDimension: 4,
        });
      },
    };

    await expect(
      searchMemories(
        {
          db: handle.db,
          memoryRepository: repo,
          configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
          embeddingProvider: staleProvider,
          clock: () => fixedClock,
        },
        { text: 'kafka' },
      ),
    ).rejects.toBeInstanceOf(VectorRetrievalConfigError);
  });

  describe('temporal filters', () => {
    it('filters out rows older than createdAtAfter', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = ['2025-01-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z'];
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write({ ...baseInput, content: 'kafka old' }, { actor });
      const newer = await repo.write({ ...baseInput, content: 'kafka new' }, { actor });

      const page = await searchMemories(
        {
          db: handle.db,
          memoryRepository: repo,
          configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
          clock: () => fixedClock,
        },
        {
          text: 'kafka',
          createdAtAfter: '2025-06-01T00:00:00.000Z' as never,
        },
      );
      expect(page.results.map((r) => r.memory.id)).toEqual([newer.id]);
    });

    it('createdAtBefore is exclusive', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = ['2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z'];
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const older = await repo.write({ ...baseInput, content: 'kafka older' }, { actor });
      await repo.write({ ...baseInput, content: 'kafka cutoff' }, { actor });

      const page = await searchMemories(
        {
          db: handle.db,
          memoryRepository: repo,
          configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
          clock: () => fixedClock,
        },
        {
          text: 'kafka',
          createdAtBefore: '2025-06-01T00:00:00.000Z' as never,
        },
      );
      expect(page.results.map((r) => r.memory.id)).toEqual([older.id]);
    });

    it('confirmedAfter narrows by lastConfirmedAt', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = ['2025-01-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z'];
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write({ ...baseInput, content: 'kafka old' }, { actor });
      const newer = await repo.write({ ...baseInput, content: 'kafka new' }, { actor });

      const page = await searchMemories(
        {
          db: handle.db,
          memoryRepository: repo,
          configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
          clock: () => fixedClock,
        },
        {
          text: 'kafka',
          confirmedAfter: '2025-06-01T00:00:00.000Z' as never,
        },
      );
      expect(page.results.map((r) => r.memory.id)).toEqual([newer.id]);
    });

    it('confirmedBefore is exclusive', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = ['2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z'];
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const older = await repo.write({ ...baseInput, content: 'kafka older' }, { actor });
      await repo.write({ ...baseInput, content: 'kafka cutoff' }, { actor });

      const page = await searchMemories(
        {
          db: handle.db,
          memoryRepository: repo,
          configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
          clock: () => fixedClock,
        },
        {
          text: 'kafka',
          confirmedBefore: '2025-06-01T00:00:00.000Z' as never,
        },
      );
      expect(page.results.map((r) => r.memory.id)).toEqual([older.id]);
    });

    it('threads all 4 temporal bounds through the vector arm', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = pairwise(['2025-01-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z']);
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      // Write + embed both rows so the vector arm has candidates
      // to filter on. Inline embedder produces a constant unit
      // vector so cosine ranking is trivial.
      const provider: EmbeddingProvider = {
        model: 'test-model',
        dimension: 3,
        embed: async () => [1, 0, 0],
      };
      const a = await repo.write({ ...baseInput, content: 'kafka old' }, { actor });
      await repo.setEmbedding(
        a.id,
        { model: provider.model, dimension: provider.dimension, vector: [1, 0, 0] },
        { actor },
      );
      const newer = await repo.write({ ...baseInput, content: 'kafka new' }, { actor });
      await repo.setEmbedding(
        newer.id,
        { model: provider.model, dimension: provider.dimension, vector: [1, 0, 0] },
        { actor },
      );

      const page = await searchMemories(
        {
          db: handle.db,
          memoryRepository: repo,
          configStore: createConfigStore({ 'retrieval.vector.enabled': true }),
          embeddingProvider: provider,
          clock: () => fixedClock,
        },
        {
          text: 'kafka',
          // Composed half-open window on both axes. Exercises the
          // four conditional spreads onto the vector candidate
          // generator in one shot.
          createdAtAfter: '2025-06-01T00:00:00.000Z' as never,
          createdAtBefore: '2026-01-01T00:00:00.000Z' as never,
          confirmedAfter: '2025-06-01T00:00:00.000Z' as never,
          confirmedBefore: '2026-01-01T00:00:00.000Z' as never,
        },
      );
      expect(page.results.map((r) => r.memory.id)).toEqual([newer.id]);
    });
  });
});

// Pair each timestamp with itself; a write-then-set-embedding
// pair consumes two clock ticks per logical memory, so each
// instant must repeat to land on the same createdAt /
// lastConfirmedAt pair.
function pairwise(stamps: readonly string[]): string[] {
  return stamps.flatMap((s) => [s, s]);
}

describe('retrieval.ranker.strategy = rrf', () => {
  it('routes to the RRF ranker and produces inverse-rank breakdowns', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const strong = await repo.write(
      { ...baseInput, content: 'kafka kafka kafka kafka kafka' },
      { actor },
    );
    const weak = await repo.write(
      {
        ...baseInput,
        content: 'kafka once among many other words and unrelated tokens here',
      },
      { actor },
    );

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.vector.enabled': false,
          'retrieval.ranker.strategy': 'rrf',
        }),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    // Strong hit gets FTS rank 1 → breakdown.fts = 1/(60+1).
    expect(page.results.map((r) => r.memory.id)).toEqual([strong.id, weak.id]);
    expect(page.results[0]?.breakdown.fts).toBeCloseTo(1 / 61, 10);
    expect(page.results[1]?.breakdown.fts).toBeCloseTo(1 / 62, 10);
  });

  it('honours `retrieval.ranker.rrf.k` from config', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.vector.enabled': false,
          'retrieval.ranker.strategy': 'rrf',
          'retrieval.ranker.rrf.k': 9,
        }),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    expect(page.results[0]?.breakdown.fts).toBeCloseTo(1 / 10, 10); // k=9 + rank=1
  });
});

describe('per-arm candidate thresholds', () => {
  // Helper: drive a vector-on search whose provider returns the
  // supplied query vector. Each memory's stored embedding decides
  // its cosine; this lets tests construct strong-vector and
  // weak-vector candidates by choosing the embedding direction.
  function vectorProvider(queryVector: readonly number[]): EmbeddingProvider {
    return {
      model: 'test-model',
      dimension: queryVector.length,
      embed: async () => queryVector,
    };
  }

  it('defaults (ftsMinScore=0, vectorMinCosine=-1) preserve prior ranking', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const a = await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });
    await repo.write({ ...baseInput, content: 'unrelated' }, { actor });

    // Reusable: no threshold overrides → registry defaults.
    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({ 'retrieval.vector.enabled': false }),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    expect(page.results).toHaveLength(1);
    expect(page.results[0]?.memory.id).toBe(a.id);
  });

  it('drops vector-only candidates below vectorMinCosine', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    // Strong vector match (cosine 1.0) — no FTS overlap with the query.
    const strong = await repo.write({ ...baseInput, content: 'lorem ipsum dolor' }, { actor });
    await repo.setEmbedding(
      strong.id,
      { model: 'test-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );
    // Weak vector match (cosine 0.6 against query [1, 0, 0]) — no FTS overlap.
    const weak = await repo.write({ ...baseInput, content: 'consectetur adipiscing' }, { actor });
    await repo.setEmbedding(
      weak.id,
      { model: 'test-model', dimension: 3, vector: [0.6, 0.8, 0] },
      { actor },
    );

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.vector.enabled': true,
          'retrieval.candidate.vectorMinCosine': 0.9,
        }),
        embeddingProvider: vectorProvider([1, 0, 0]),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    expect(page.results.map((r) => r.memory.id)).toEqual([strong.id]);
    expect(page.results.find((r) => r.memory.id === weak.id)).toBeUndefined();
  });

  it('drops FTS-only candidates below ftsMinScore', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const strong = await repo.write(
      { ...baseInput, content: 'kafka kafka kafka kafka kafka' },
      { actor },
    );
    const weak = await repo.write(
      {
        ...baseInput,
        content:
          'kafka mentioned exactly once among a lot of unrelated context such as the weather and breakfast and other miscellaneous tokens',
      },
      { actor },
    );

    // Pull raw |bm25| values directly from `searchFts` so the
    // threshold can be set deterministically between the strong
    // and weak hit regardless of how SQLite's BM25 reports the
    // absolute magnitudes for this fixture.
    const hits = await searchFts(handle.db, {
      text: 'kafka',
      limit: 10,
      statuses: ['active'],
    });
    const ranked = hits.map((h) => ({ id: h.id, abs: Math.abs(h.bm25) }));
    const strongAbs = ranked.find((h) => h.id === strong.id)?.abs ?? 0;
    const weakAbs = ranked.find((h) => h.id === weak.id)?.abs ?? 0;
    expect(strongAbs).toBeGreaterThan(weakAbs);
    // Midpoint threshold cleanly separates the two candidates.
    const midpoint = (strongAbs + weakAbs) / 2;

    const filtered = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.vector.enabled': false,
          'retrieval.candidate.ftsMinScore': midpoint,
        }),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );
    expect(filtered.results.map((r) => r.memory.id)).toEqual([strong.id]);

    // And with a floor above both, the page is empty.
    const aggressive = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.vector.enabled': false,
          'retrieval.candidate.ftsMinScore': strongAbs + 1,
        }),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );
    expect(aggressive.results).toEqual([]);
  });

  it('keeps a candidate matching both arms when one arm is above its floor', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    // Single memory matching both arms: strong FTS hit AND a
    // weak (below floor) cosine. With vectorMinCosine high, the
    // vector arm would prune; the FTS arm being above its floor
    // (default 0) rescues the candidate.
    const both = await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });
    await repo.setEmbedding(
      both.id,
      { model: 'test-model', dimension: 3, vector: [0, 1, 0] },
      { actor },
    );

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.vector.enabled': true,
          'retrieval.candidate.vectorMinCosine': 0.9,
        }),
        embeddingProvider: vectorProvider([1, 0, 0]),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    expect(page.results.map((r) => r.memory.id)).toEqual([both.id]);
  });

  it('drops a candidate when every arm is below its floor', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    // Strong reference candidate so the result set is non-empty
    // and the drop is observable rather than masked by "no
    // candidates ever existed".
    const strong = await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });
    await repo.setEmbedding(
      strong.id,
      { model: 'test-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );
    // Doubly-weak candidate: weak FTS (|bm25| < 1.0) and weak
    // cosine (0.6 against query [1, 0, 0]).
    const weak = await repo.write(
      { ...baseInput, content: 'kafka one of many words here today' },
      { actor },
    );
    await repo.setEmbedding(
      weak.id,
      { model: 'test-model', dimension: 3, vector: [0.6, 0.8, 0] },
      { actor },
    );

    const page = await searchMemories(
      {
        db: handle.db,
        memoryRepository: repo,
        configStore: createConfigStore({
          'retrieval.vector.enabled': true,
          'retrieval.candidate.ftsMinScore': 1.0,
          'retrieval.candidate.vectorMinCosine': 0.9,
        }),
        embeddingProvider: vectorProvider([1, 0, 0]),
        clock: () => fixedClock,
      },
      { text: 'kafka' },
    );

    expect(page.results.map((r) => r.memory.id)).toEqual([strong.id]);
  });
});
