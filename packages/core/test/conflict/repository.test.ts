import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createConflictRepository } from '../../src/conflict/repository.js';
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
  tags: [],
  pinned: false,
  content: 'baseline fact',
  summary: null,
  storedConfidence: 0.9,
};

async function seedTwoMemories() {
  const handle = await fixture();
  const memoryRepo = createMemoryRepository(handle.db, {
    clock: () => fixedClock as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const a = await memoryRepo.write(baseInput, { actor });
  const b = await memoryRepo.write({ ...baseInput, content: 'another fact' }, { actor });
  return { handle, memoryRepo, a, b };
}

describe('createConflictRepository', () => {
  describe('open', () => {
    it('inserts a conflict row and an opened event in one tx', async () => {
      const { handle, a, b } = await seedTwoMemories();
      const repo = createConflictRepository(handle.db, {
        clock: () => fixedClock as never,
        conflictIdFactory: counterFactory('C0') as never,
        eventIdFactory: counterFactory('CE'),
      });

      const conflict = await repo.open(
        {
          newMemoryId: b.id,
          conflictingMemoryId: a.id,
          kind: 'fact',
          evidence: { reason: 'test' },
        },
        { actor },
      );

      expect(conflict.openedAt).toBe(fixedClock);
      expect(conflict.resolvedAt).toBeNull();
      expect(conflict.resolution).toBeNull();
      expect(conflict.evidence).toEqual({ reason: 'test' });

      const events = await repo.events(conflict.id);
      expect(events).toHaveLength(1);
      const opened = events[0];
      if (opened?.type !== 'opened') {
        throw new Error('expected opened event');
      }
      expect(opened.at).toBe(fixedClock);
      expect(opened.payload.newMemoryId).toBe(b.id);
    });

    it('rolls back when foreign-key constraints fail', async () => {
      const { handle, a } = await seedTwoMemories();
      const repo = createConflictRepository(handle.db, {
        clock: () => fixedClock as never,
        conflictIdFactory: counterFactory('C0') as never,
        eventIdFactory: counterFactory('CE'),
      });

      await expect(
        repo.open(
          {
            newMemoryId: '01HXXXXXXXXXXXXXXXXXXXXXXX' as typeof a.id,
            conflictingMemoryId: a.id,
            kind: 'fact',
            evidence: {},
          },
          { actor },
        ),
      ).rejects.toThrow();

      // No partial state left behind.
      const list = await repo.list();
      expect(list).toEqual([]);
    });
  });

  describe('resolve', () => {
    it('records the resolution and emits a resolved event', async () => {
      const { handle, a, b } = await seedTwoMemories();
      const clocks = ['2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z'];
      let clockIdx = 0;
      const repo = createConflictRepository(handle.db, {
        clock: () => clocks[clockIdx++] as never,
        conflictIdFactory: counterFactory('C0') as never,
        eventIdFactory: counterFactory('CE'),
      });
      const conflict = await repo.open(
        {
          newMemoryId: b.id,
          conflictingMemoryId: a.id,
          kind: 'fact',
          evidence: {},
        },
        { actor },
      );

      const resolved = await repo.resolve(conflict.id, 'accept-new', { actor });
      expect(resolved.resolution).toBe('accept-new');
      expect(resolved.resolvedAt).toBe('2025-01-02T00:00:00.000Z');

      const events = await repo.events(conflict.id);
      expect(events.map((e) => e.type)).toEqual(['opened', 'resolved']);
    });

    it('rejects double-resolve', async () => {
      const { handle, a, b } = await seedTwoMemories();
      const clocks = [
        '2025-01-01T00:00:00.000Z',
        '2025-01-02T00:00:00.000Z',
        '2025-01-03T00:00:00.000Z',
      ];
      let clockIdx = 0;
      const repo = createConflictRepository(handle.db, {
        clock: () => clocks[clockIdx++] as never,
        conflictIdFactory: counterFactory('C0') as never,
        eventIdFactory: counterFactory('CE'),
      });
      const conflict = await repo.open(
        {
          newMemoryId: b.id,
          conflictingMemoryId: a.id,
          kind: 'fact',
          evidence: {},
        },
        { actor },
      );
      await repo.resolve(conflict.id, 'accept-new', { actor });
      await expect(repo.resolve(conflict.id, 'ignore', { actor })).rejects.toThrow(
        /already resolved/,
      );
    });

    it('throws when the conflict does not exist', async () => {
      const { handle } = await seedTwoMemories();
      const repo = createConflictRepository(handle.db);
      await expect(
        repo.resolve('01HXXXXXXXXXXXXXXXXXXXXXXX' as never, 'ignore', {
          actor,
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('list and read', () => {
    it('filters by `open` flag', async () => {
      const { handle, a, b } = await seedTwoMemories();
      let i = 0;
      const clocks = [
        '2025-01-01T00:00:00.000Z',
        '2025-01-02T00:00:00.000Z',
        '2025-01-03T00:00:00.000Z',
        '2025-01-04T00:00:00.000Z',
      ];
      const repo = createConflictRepository(handle.db, {
        clock: () => clocks[i++] as never,
        conflictIdFactory: counterFactory('C0') as never,
        eventIdFactory: counterFactory('CE'),
      });
      const c1 = await repo.open(
        {
          newMemoryId: b.id,
          conflictingMemoryId: a.id,
          kind: 'fact',
          evidence: {},
        },
        { actor },
      );
      const c2 = await repo.open(
        {
          newMemoryId: a.id,
          conflictingMemoryId: b.id,
          kind: 'fact',
          evidence: {},
        },
        { actor },
      );
      await repo.resolve(c1.id, 'ignore', { actor });

      const open = await repo.list({ open: true });
      expect(open.map((c) => c.id)).toEqual([c2.id]);

      const closed = await repo.list({ open: false });
      expect(closed.map((c) => c.id)).toEqual([c1.id]);
    });

    it('filters by memoryId on either side', async () => {
      const { handle, a, b } = await seedTwoMemories();
      const repo = createConflictRepository(handle.db, {
        clock: () => fixedClock as never,
        conflictIdFactory: counterFactory('C0') as never,
        eventIdFactory: counterFactory('CE'),
      });
      await repo.open(
        {
          newMemoryId: b.id,
          conflictingMemoryId: a.id,
          kind: 'fact',
          evidence: {},
        },
        { actor },
      );
      const list = await repo.list({ memoryId: a.id });
      expect(list).toHaveLength(1);
      const empty = await repo.list({
        memoryId: '01HXXXXXXXXXXXXXXXXXXXXXXX' as typeof a.id,
      });
      expect(empty).toEqual([]);
    });

    it('returns null for unknown conflict id', async () => {
      const { handle } = await seedTwoMemories();
      const repo = createConflictRepository(handle.db);
      const r = await repo.read('01HXXXXXXXXXXXXXXXXXXXXXXX' as never);
      expect(r).toBeNull();
    });

    it('rejects invalid limits', async () => {
      const { handle } = await seedTwoMemories();
      const repo = createConflictRepository(handle.db);
      await expect(repo.list({ limit: 0 })).rejects.toThrow(/positive integer/);
      await expect(repo.list({ limit: -5 })).rejects.toThrow(/positive integer/);
    });
  });
});
