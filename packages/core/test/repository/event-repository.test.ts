import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventRepository } from '../../src/repository/event-repository.js';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
import type { MemoryWriteInput } from '../../src/repository/memory-repository.js';
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
    const num = String(i).padStart(24, '0');
    return `${prefix}${num}`;
  };
}

const fixedClock = '2025-01-01T00:00:00.000Z';
const actor: ActorRef = { type: 'cli' };

const baseInput: MemoryWriteInput = {
  scope: { type: 'global' },
  owner: { type: 'local', id: 'tester' },
  kind: { type: 'fact' },
  tags: ['hello'],
  pinned: false,
  content: 'the meeting starts at 10am',
  summary: null,
  storedConfidence: 0.9,
};

/**
 * Helper: write `n` memories on monotonically-increasing ids so
 * the resulting events sort cleanly. Returns the memory ids in
 * write order. The memory-repo tests already cover write itself;
 * here we only need an audit-log fixture.
 */
async function seed(handle: Awaited<ReturnType<typeof fixture>>, n: number) {
  const repo = createMemoryRepository(handle.db, {
    clock: () => fixedClock as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const m = await repo.write(baseInput, { actor });
    ids.push(m.id);
  }
  return { repo, ids };
}

describe('createEventRepository', () => {
  describe('listForMemory', () => {
    it('returns events for one memory in commit order', async () => {
      const handle = await fixture();
      const { repo, ids } = await seed(handle, 1);
      const id = ids[0];
      if (id === undefined) {
        throw new Error('seed returned no ids');
      }
      await repo.confirm(id, { actor });
      await repo.update(id, { pinned: true }, { actor });

      const events = await createEventRepository(handle.db).listForMemory(id);
      expect(events.map((e) => e.type)).toEqual(['created', 'confirmed', 'updated']);
      // The ULID-shaped event ids are monotonically increasing,
      // and the repo lists in ascending id order, so the array
      // is already commit order.
      expect(events.every((e) => e.memoryId === id)).toBe(true);
    });

    it('filters by event type', async () => {
      const handle = await fixture();
      const { repo, ids } = await seed(handle, 1);
      const id = ids[0];
      if (id === undefined) {
        throw new Error('seed returned no ids');
      }
      await repo.confirm(id, { actor });
      await repo.forget(id, null, { actor });

      const events = await createEventRepository(handle.db).listForMemory(id, {
        types: ['confirmed', 'forgotten'],
      });
      expect(events.map((e) => e.type)).toEqual(['confirmed', 'forgotten']);
    });

    it('respects the limit and rejects invalid limits', async () => {
      const handle = await fixture();
      const { repo, ids } = await seed(handle, 1);
      const id = ids[0];
      if (id === undefined) {
        throw new Error('seed returned no ids');
      }
      await repo.confirm(id, { actor });
      await repo.confirm(id, { actor });

      const er = createEventRepository(handle.db);
      const events = await er.listForMemory(id, { limit: 2 });
      expect(events).toHaveLength(2);
      await expect(er.listForMemory(id, { limit: 0 })).rejects.toThrow(/positive integer/);
      await expect(er.listForMemory(id, { limit: -1 })).rejects.toThrow(/positive integer/);
    });

    it('returns an empty array for an unknown memory id', async () => {
      const handle = await fixture();
      await seed(handle, 0);
      const events = await createEventRepository(handle.db).listForMemory(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV' as never,
      );
      expect(events).toEqual([]);
    });
  });

  describe('listRecent', () => {
    it('returns the cross-memory tail newest-first', async () => {
      const handle = await fixture();
      const { ids } = await seed(handle, 3);
      const events = await createEventRepository(handle.db).listRecent({
        limit: 2,
      });
      expect(events).toHaveLength(2);
      // Memories were created M0...01, M0...02, M0...03 in order;
      // listRecent is desc on event id, so the newest two events
      // belong to the third and second memories respectively.
      expect(events.map((e) => e.memoryId)).toEqual([ids[2], ids[1]]);
    });
  });

  describe('latestForMemory', () => {
    it('returns the most recent event', async () => {
      const handle = await fixture();
      const { repo, ids } = await seed(handle, 1);
      const id = ids[0];
      if (id === undefined) {
        throw new Error('seed returned no ids');
      }
      await repo.confirm(id, { actor });
      const ev = await createEventRepository(handle.db).latestForMemory(id);
      expect(ev?.type).toBe('confirmed');
    });

    it('returns null when there are no events for the id', async () => {
      const handle = await fixture();
      await seed(handle, 0);
      const ev = await createEventRepository(handle.db).latestForMemory(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV' as never,
      );
      expect(ev).toBeNull();
    });
  });

  describe('countForMemory', () => {
    it('returns the total event count for a memory', async () => {
      const handle = await fixture();
      const { repo, ids } = await seed(handle, 1);
      const id = ids[0];
      if (id === undefined) {
        throw new Error('seed returned no ids');
      }
      await repo.confirm(id, { actor });
      await repo.confirm(id, { actor });
      const n = await createEventRepository(handle.db).countForMemory(id);
      expect(n).toBe(3);
    });

    it('returns 0 for an unknown id', async () => {
      const handle = await fixture();
      await seed(handle, 0);
      const n = await createEventRepository(handle.db).countForMemory(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV' as never,
      );
      expect(n).toBe(0);
    });
  });

  describe('read', () => {
    it('returns the parsed event for a known id', async () => {
      const handle = await fixture();
      const { repo, ids } = await seed(handle, 1);
      const id = ids[0];
      if (id === undefined) throw new Error('seed returned no ids');
      // Append a confirm so there are two events on the row;
      // pick the second one to make sure `read` is not just
      // returning the first match.
      await repo.confirm(id, { actor });
      const eventRepo = createEventRepository(handle.db);
      const events = await eventRepo.listForMemory(id);
      const target = events[1];
      if (target === undefined) throw new Error('expected at least two events');
      const fetched = await eventRepo.read(target.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(target.id);
      expect(fetched?.memoryId).toBe(id);
      expect(fetched?.type).toBe(target.type);
    });

    it('returns null for an unknown id', async () => {
      const handle = await fixture();
      const fetched = await createEventRepository(handle.db).read(
        '01ARZ3NDEKTSV4RRFFQ69G5FAV' as never,
      );
      expect(fetched).toBeNull();
    });
  });
});
