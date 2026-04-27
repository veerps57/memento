import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfigStore } from '../../src/config/index.js';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
import type { MemoryWriteInput } from '../../src/repository/memory-repository.js';
import { searchMemories } from '../../src/retrieval/pipeline.js';
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
        configStore: createConfigStore(),
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
        configStore: createConfigStore(),
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
        configStore: createConfigStore({ 'retrieval.search.maxLimit': 2 }),
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
        configStore: createConfigStore(),
        clock: () => fixedClock,
      },
      {
        text: 'kafka',
        scopes: [{ type: 'workspace', path: '/x' as never }],
      },
    );
    expect(page.results.map((r) => r.memory.id)).toEqual([ws.id]);
  });
});
