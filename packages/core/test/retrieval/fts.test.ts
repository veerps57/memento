import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
import type { MemoryWriteInput } from '../../src/repository/memory-repository.js';
import { searchFts } from '../../src/retrieval/fts.js';
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

describe('searchFts', () => {
  it('returns hits ordered by bm25 ascending (most-relevant first)', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const a = await repo.write({ ...baseInput, content: 'kafka kafka kafka' }, { actor });
    const b = await repo.write({ ...baseInput, content: 'kafka mentioned once' }, { actor });
    await repo.write({ ...baseInput, content: 'unrelated text' }, { actor });

    const hits = await searchFts(handle.db, {
      text: 'kafka',
      limit: 10,
      statuses: ['active'],
    });
    expect(hits.map((h) => h.id)).toEqual([a.id, b.id]);
    expect(hits[0]?.bm25).toBeLessThanOrEqual(hits[1]?.bm25 ?? 0);
  });

  it('returns no hits when the cleaned query is empty', async () => {
    const handle = await fixture();
    const hits = await searchFts(handle.db, {
      text: '"":()',
      limit: 10,
      statuses: ['active'],
    });
    expect(hits).toEqual([]);
  });

  it('honours status, kind, and scope filters', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const m1 = await repo.write({ ...baseInput, content: 'kafka one' }, { actor });
    await repo.write(
      { ...baseInput, kind: { type: 'preference' }, content: 'kafka two' },
      { actor },
    );
    const m3 = await repo.write(
      {
        ...baseInput,
        kind: { type: 'preference' },
        scope: { type: 'workspace', path: '/x' as never },
        content: 'kafka three',
      },
      { actor },
    );

    const filteredByKind = await searchFts(handle.db, {
      text: 'kafka',
      limit: 10,
      statuses: ['active'],
      kinds: ['fact'],
    });
    expect(filteredByKind.map((h) => h.id)).toEqual([m1.id]);

    const filteredByScope = await searchFts(handle.db, {
      text: 'kafka',
      limit: 10,
      statuses: ['active'],
      scopes: [{ type: 'workspace', path: '/x' as never }],
    });
    expect(filteredByScope.map((h) => h.id)).toEqual([m3.id]);

    const noStatus = await searchFts(handle.db, {
      text: 'kafka',
      limit: 10,
      statuses: [],
    });
    expect(noStatus).toEqual([]);
  });

  it('respects the limit', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    for (let i = 0; i < 5; i += 1) {
      await repo.write({ ...baseInput, content: `kafka entry ${i}` }, { actor });
    }
    const hits = await searchFts(handle.db, {
      text: 'kafka',
      limit: 2,
      statuses: ['active'],
    });
    expect(hits).toHaveLength(2);
  });

  describe('temporal filters', () => {
    it('filters rows older than createdAtAfter', async () => {
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

      const hits = await searchFts(handle.db, {
        text: 'kafka',
        limit: 10,
        statuses: ['active'],
        createdAtAfter: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([newer.id]);
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

      const hits = await searchFts(handle.db, {
        text: 'kafka',
        limit: 10,
        statuses: ['active'],
        createdAtBefore: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([older.id]);
    });

    it('confirmedAfter narrows by last_confirmed_at', async () => {
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

      const hits = await searchFts(handle.db, {
        text: 'kafka',
        limit: 10,
        statuses: ['active'],
        confirmedAfter: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([newer.id]);
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

      const hits = await searchFts(handle.db, {
        text: 'kafka',
        limit: 10,
        statuses: ['active'],
        confirmedBefore: '2025-06-01T00:00:00.000Z' as never,
      });
      expect(hits.map((h) => h.id)).toEqual([older.id]);
    });
  });
});
