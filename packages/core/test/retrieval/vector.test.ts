import type { ActorRef, Memory } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type MemoryWriteInput,
  createMemoryRepository,
} from '../../src/repository/memory-repository.js';
import { StaleEmbeddingError, cosineSimilarity, searchVector } from '../../src/retrieval/vector.js';
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
const TEST_MODEL = 'test-model';
const TEST_DIM = 3;

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

async function writeWithEmbedding(
  repo: ReturnType<typeof createMemoryRepository>,
  content: string,
  vector: readonly number[],
  overrides: { model?: string; dimension?: number } = {},
): Promise<Memory> {
  const m = await repo.write({ ...baseInput, content }, { actor });
  await repo.setEmbedding(
    m.id,
    {
      model: overrides.model ?? TEST_MODEL,
      dimension: overrides.dimension ?? TEST_DIM,
      vector,
    },
    { actor },
  );
  return m;
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('returns -1 for antiparallel vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 10);
  });

  it('handles non-unit-length inputs', () => {
    // (3, 4) has norm 5; (6, 8) is parallel — cosine = 1.
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1, 10);
  });

  it('returns 0 when either input is the zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrowError(/dimension mismatch/);
  });
});

describe('searchVector', () => {
  it('returns hits ordered by cosine similarity descending', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const a = await writeWithEmbedding(repo, 'a', [1, 0, 0]);
    const b = await writeWithEmbedding(repo, 'b', [0.9, 0.1, 0]);
    const c = await writeWithEmbedding(repo, 'c', [0, 1, 0]);

    const hits = await searchVector(handle.db, {
      queryVector: [1, 0, 0],
      provider: { model: TEST_MODEL, dimension: TEST_DIM },
      limit: 10,
      statuses: ['active'],
    });

    expect(hits.map((h) => h.id)).toEqual([a.id, b.id, c.id]);
    expect(hits[0]?.cosine).toBeCloseTo(1, 10);
    expect(hits[1]?.cosine).toBeGreaterThan(hits[2]?.cosine ?? 1);
  });

  it('skips memories that have no embedding (embedding_json IS NULL)', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, content: 'no embedding' }, { actor });
    const b = await writeWithEmbedding(repo, 'embedded', [1, 0, 0]);

    const hits = await searchVector(handle.db, {
      queryVector: [1, 0, 0],
      provider: { model: TEST_MODEL, dimension: TEST_DIM },
      limit: 10,
      statuses: ['active'],
    });

    expect(hits.map((h) => h.id)).toEqual([b.id]);
  });

  it('respects the limit', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await writeWithEmbedding(repo, 'a', [1, 0, 0]);
    await writeWithEmbedding(repo, 'b', [0.9, 0.1, 0]);
    await writeWithEmbedding(repo, 'c', [0.8, 0.2, 0]);

    const hits = await searchVector(handle.db, {
      queryVector: [1, 0, 0],
      provider: { model: TEST_MODEL, dimension: TEST_DIM },
      limit: 2,
      statuses: ['active'],
    });
    expect(hits).toHaveLength(2);
  });

  it('honours status, kind, and scope filters', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const factGlobal = await writeWithEmbedding(repo, 'fg', [1, 0, 0]);
    const prefGlobal = await repo.write(
      { ...baseInput, kind: { type: 'preference' }, content: 'pg' },
      { actor },
    );
    await repo.setEmbedding(
      prefGlobal.id,
      { model: TEST_MODEL, dimension: TEST_DIM, vector: [1, 0, 0] },
      { actor },
    );
    const factWorkspace = await repo.write(
      { ...baseInput, scope: { type: 'workspace', path: '/ws' as never }, content: 'fw' },
      { actor },
    );
    await repo.setEmbedding(
      factWorkspace.id,
      { model: TEST_MODEL, dimension: TEST_DIM, vector: [1, 0, 0] },
      { actor },
    );

    const onlyFacts = await searchVector(handle.db, {
      queryVector: [1, 0, 0],
      provider: { model: TEST_MODEL, dimension: TEST_DIM },
      limit: 10,
      statuses: ['active'],
      kinds: ['fact'],
    });
    expect(new Set(onlyFacts.map((h) => h.id))).toEqual(new Set([factGlobal.id, factWorkspace.id]));

    const onlyGlobal = await searchVector(handle.db, {
      queryVector: [1, 0, 0],
      provider: { model: TEST_MODEL, dimension: TEST_DIM },
      limit: 10,
      statuses: ['active'],
      scopes: [{ type: 'global' }],
    });
    expect(new Set(onlyGlobal.map((h) => h.id))).toEqual(new Set([factGlobal.id, prefGlobal.id]));
  });

  it('throws StaleEmbeddingError when a row was embedded with a different model', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await writeWithEmbedding(repo, 'old', [1, 0, 0], { model: 'older-model' });

    await expect(
      searchVector(handle.db, {
        queryVector: [1, 0, 0],
        provider: { model: TEST_MODEL, dimension: TEST_DIM },
        limit: 10,
        statuses: ['active'],
      }),
    ).rejects.toBeInstanceOf(StaleEmbeddingError);
  });

  it('throws StaleEmbeddingError when a row was embedded with a different dimension', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await writeWithEmbedding(repo, 'd4', [1, 0, 0, 0], { dimension: 4 });

    await expect(
      searchVector(handle.db, {
        queryVector: [1, 0, 0],
        provider: { model: TEST_MODEL, dimension: TEST_DIM },
        limit: 10,
        statuses: ['active'],
      }),
    ).rejects.toBeInstanceOf(StaleEmbeddingError);
  });

  it('throws when query vector length does not match provider dimension', async () => {
    const handle = await fixture();
    await expect(
      searchVector(handle.db, {
        queryVector: [1, 0],
        provider: { model: TEST_MODEL, dimension: TEST_DIM },
        limit: 10,
        statuses: ['active'],
      }),
    ).rejects.toThrowError(/queryVector length/);
  });

  it('returns no candidates for a zero-magnitude query vector', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await writeWithEmbedding(repo, 'a', [1, 0, 0]);

    const hits = await searchVector(handle.db, {
      queryVector: [0, 0, 0],
      provider: { model: TEST_MODEL, dimension: TEST_DIM },
      limit: 10,
      statuses: ['active'],
    });
    expect(hits).toEqual([]);
  });

  it('returns empty when an empty filter set is supplied', async () => {
    const handle = await fixture();
    const empty = await searchVector(handle.db, {
      queryVector: [1, 0, 0],
      provider: { model: TEST_MODEL, dimension: TEST_DIM },
      limit: 10,
      statuses: [],
    });
    expect(empty).toEqual([]);
  });

  describe('temporal filters', () => {
    // `writeWithEmbedding` issues two repo calls (`write`,
    // `setEmbedding`) and each one reads the clock, so a single
    // logical write consumes two consecutive clock entries. The
    // helper duplicates each timestamp pair-wise so a memory's
    // createdAt and lastConfirmedAt land on the same instant.
    function pairwise(stamps: readonly string[]): string[] {
      return stamps.flatMap((s) => [s, s]);
    }

    it('filters out rows older than createdAtAfter', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = pairwise(['2025-01-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z']);
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await writeWithEmbedding(repo, 'old', [1, 0, 0]);
      const newer = await writeWithEmbedding(repo, 'new', [1, 0, 0]);

      const hits = await searchVector(handle.db, {
        queryVector: [1, 0, 0],
        provider: { model: TEST_MODEL, dimension: TEST_DIM },
        limit: 10,
        statuses: ['active'],
        createdAtAfter: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([newer.id]);
    });

    it('createdAtBefore is exclusive', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = pairwise(['2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z']);
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const older = await writeWithEmbedding(repo, 'older', [1, 0, 0]);
      await writeWithEmbedding(repo, 'cutoff', [1, 0, 0]);

      const hits = await searchVector(handle.db, {
        queryVector: [1, 0, 0],
        provider: { model: TEST_MODEL, dimension: TEST_DIM },
        limit: 10,
        statuses: ['active'],
        createdAtBefore: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([older.id]);
    });

    it('confirmedAfter narrows by last_confirmed_at', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = pairwise(['2025-01-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z']);
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await writeWithEmbedding(repo, 'old', [1, 0, 0]);
      const newer = await writeWithEmbedding(repo, 'new', [1, 0, 0]);

      const hits = await searchVector(handle.db, {
        queryVector: [1, 0, 0],
        provider: { model: TEST_MODEL, dimension: TEST_DIM },
        limit: 10,
        statuses: ['active'],
        confirmedAfter: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([newer.id]);
    });

    it('confirmedBefore is exclusive', async () => {
      const handle = await fixture();
      let i = 0;
      const clocks = pairwise(['2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z']);
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const older = await writeWithEmbedding(repo, 'older', [1, 0, 0]);
      await writeWithEmbedding(repo, 'cutoff', [1, 0, 0]);

      const hits = await searchVector(handle.db, {
        queryVector: [1, 0, 0],
        provider: { model: TEST_MODEL, dimension: TEST_DIM },
        limit: 10,
        statuses: ['active'],
        confirmedBefore: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([older.id]);
    });
  });
});
