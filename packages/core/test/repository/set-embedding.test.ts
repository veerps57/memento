import type { ActorRef, MemoryId } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type MemoryWriteInput,
  createMemoryRepository,
} from '../../src/repository/memory-repository.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

interface OpenHandle {
  close(): void;
}
const handles: OpenHandle[] = [];
afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
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
    const num = String(i).padStart(26 - prefix.length, '0');
    return `${prefix}${num}`;
  };
}

const actor: ActorRef = { type: 'cli' };

const baseInput: MemoryWriteInput = {
  scope: { type: 'global' },
  owner: { type: 'local', id: 'tester' },
  kind: { type: 'fact' },
  tags: ['x'],
  pinned: false,
  content: 'the meeting starts at 10am',
  summary: null,
  storedConfidence: 0.9,
};

function makeVector(dim: number): number[] {
  const v: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    v.push(i / dim);
  }
  return v;
}

describe('MemoryRepository.setEmbedding', () => {
  it('persists the embedding and emits a `reembedded` event in one transaction', async () => {
    const handle = await fixture();
    let now = '2025-01-01T00:00:00.000Z';
    const repo = createMemoryRepository(handle.db, {
      clock: () => now as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    const memory = await repo.write(baseInput, { actor });

    now = '2025-02-01T00:00:00.000Z';
    const updated = await repo.setEmbedding(
      memory.id,
      {
        model: 'bge-small-en-v1.5',
        dimension: 4,
        vector: [0.1, 0.2, 0.3, 0.4],
      },
      { actor },
    );

    expect(updated.embedding).not.toBeNull();
    expect(updated.embedding?.model).toBe('bge-small-en-v1.5');
    expect(updated.embedding?.dimension).toBe(4);
    expect(updated.embedding?.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(updated.embedding?.createdAt).toBe(now);

    const rows = handle.raw
      .prepare('select type, payload_json from memory_events where memory_id = ? order by at asc')
      .all(memory.id as unknown as string) as Array<{
      type: string;
      payload_json: string;
    }>;
    expect(rows.map((r) => r.type)).toEqual(['created', 'reembedded']);
    const reembedRow = rows[1];
    expect(reembedRow).toBeDefined();
    expect(JSON.parse(reembedRow!.payload_json)).toEqual({
      model: 'bge-small-en-v1.5',
      dimension: 4,
    });
  });

  it('bumps lastConfirmedAt monotonically (MAX of existing and now)', async () => {
    const handle = await fixture();
    let now = '2025-06-01T00:00:00.000Z';
    const repo = createMemoryRepository(handle.db, {
      clock: () => now as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    const memory = await repo.write(baseInput, { actor });
    expect(memory.lastConfirmedAt).toBe(now);

    // Forward step → bumps.
    now = '2025-07-01T00:00:00.000Z';
    const forward = await repo.setEmbedding(
      memory.id,
      { model: 'm', dimension: 2, vector: [1, 2] },
      { actor },
    );
    expect(forward.lastConfirmedAt).toBe('2025-07-01T00:00:00.000Z');

    // Backward step (skewed clock) → monotonic; existing wins.
    now = '2025-03-01T00:00:00.000Z';
    const backward = await repo.setEmbedding(
      memory.id,
      { model: 'm', dimension: 2, vector: [3, 4] },
      { actor },
    );
    expect(backward.lastConfirmedAt).toBe('2025-07-01T00:00:00.000Z');
  });

  it('rejects vector / dimension mismatch via EmbeddingSchema before opening a tx', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => '2025-01-01T00:00:00.000Z' as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    const memory = await repo.write(baseInput, { actor });

    await expect(
      repo.setEmbedding(memory.id, { model: 'm', dimension: 4, vector: [1, 2, 3] }, { actor }),
    ).rejects.toThrow();

    // No reembedded event was written.
    const count = handle.raw
      .prepare(`select count(*) as n from memory_events where type = 'reembedded'`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('accepts a forgotten memory (vector retrieval over forgotten is opt-in)', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => '2025-01-01T00:00:00.000Z' as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    const memory = await repo.write(baseInput, { actor });
    await repo.forget(memory.id, null, { actor });

    const updated = await repo.setEmbedding(
      memory.id,
      { model: 'm', dimension: 2, vector: [1, 2] },
      { actor },
    );
    expect(updated.status).toBe('forgotten');
    expect(updated.embedding?.dimension).toBe(2);
  });

  it('accepts an archived memory', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => '2025-01-01T00:00:00.000Z' as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    const memory = await repo.write(baseInput, { actor });
    await repo.archive(memory.id, { actor });

    const updated = await repo.setEmbedding(
      memory.id,
      { model: 'm', dimension: 2, vector: [1, 2] },
      { actor },
    );
    expect(updated.status).toBe('archived');
    expect(updated.embedding?.dimension).toBe(2);
  });

  it('rejects on superseded memories (the chain forward-pointer makes them not a valid embed target)', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => '2025-01-01T00:00:00.000Z' as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    const old = await repo.write(baseInput, { actor });
    await repo.supersede(old.id, { ...baseInput, content: 'replacement' }, { actor });

    // `old` is now status=superseded with a non-null
    // supersededBy pointer. Embedding it would just produce
    // a vector for content that's been explicitly replaced.
    await expect(
      repo.setEmbedding(old.id, { model: 'm', dimension: 2, vector: [1, 2] }, { actor }),
    ).rejects.toThrow(/setEmbedding/);
  });

  it('rejects when the memory does not exist', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => '2025-01-01T00:00:00.000Z' as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    await expect(
      repo.setEmbedding(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV' as unknown as MemoryId,
        { model: 'm', dimension: 1, vector: [0] },
        { actor },
      ),
    ).rejects.toThrow(/setEmbedding/);
  });

  it('replaces an existing embedding with a fresh one', async () => {
    const handle = await fixture();
    let now = '2025-01-01T00:00:00.000Z';
    const repo = createMemoryRepository(handle.db, {
      clock: () => now as never,
      memoryIdFactory: counterFactory('M') as never,
      eventIdFactory: counterFactory('E'),
    });
    const memory = await repo.write(baseInput, { actor });

    now = '2025-02-01T00:00:00.000Z';
    await repo.setEmbedding(
      memory.id,
      { model: 'old', dimension: 4, vector: makeVector(4) },
      { actor },
    );

    now = '2025-03-01T00:00:00.000Z';
    const replaced = await repo.setEmbedding(
      memory.id,
      { model: 'new', dimension: 8, vector: makeVector(8) },
      { actor },
    );
    expect(replaced.embedding?.model).toBe('new');
    expect(replaced.embedding?.dimension).toBe(8);
    expect(replaced.embedding?.vector).toHaveLength(8);

    // Two reembedded events recorded.
    const rows = handle.raw
      .prepare(
        `select payload_json from memory_events where memory_id = ? and type = 'reembedded' order by at asc`,
      )
      .all(memory.id as unknown as string) as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({
      model: 'old',
      dimension: 4,
    });
    expect(JSON.parse(rows[1]!.payload_json)).toEqual({
      model: 'new',
      dimension: 8,
    });
  });
});
