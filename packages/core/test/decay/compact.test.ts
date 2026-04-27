// Compact integration tests — drive the real MemoryRepository
// against an in-memory SQLite. The decay-engine math is covered
// in `engine.test.ts`; these tests verify selection and the
// MemoryEvent fallout.

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { MS_PER_DAY, compact } from '../../src/decay/index.js';
import {
  type MemoryWriteInput,
  createEventRepository,
  createMemoryRepository,
} from '../../src/repository/index.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

const handles: Array<{ close(): void }> = [];
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
    return `${prefix}${String(i).padStart(24, '0')}`;
  };
}

const actor: ActorRef = { type: 'cli' };
const baseInput: MemoryWriteInput = {
  scope: { type: 'global' },
  owner: { type: 'local', id: 'tester' },
  kind: { type: 'fact' },
  tags: [],
  pinned: false,
  content: 'a',
  summary: null,
  storedConfidence: 1,
};

const NOW = '2026-01-01T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * MS_PER_DAY).toISOString();
}

describe('compact', () => {
  it('archives a memory whose effectiveConfidence is below threshold and is older than archiveAfter', async () => {
    const handle = await fixture();
    const writeClock = isoDaysAgo(1000); // 1000 days ago
    const repo = createMemoryRepository(handle.db, {
      clock: () => writeClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });

    // storedConfidence 0.5, fact half-life 90 days, age ~1000 days
    // → factor 0.5^(1000/90) ≈ 4.6e-4, effective ≈ 2.3e-4 < 0.05.
    const stale = await repo.write({ ...baseInput, storedConfidence: 0.5 }, { actor });

    const stats = await compact(repo, { actor, now: NOW as never });

    expect(stats.scanned).toBeGreaterThanOrEqual(1);
    expect(stats.archived).toBe(1);
    expect(stats.archivedIds).toEqual([stale.id]);

    const reread = await repo.read(stale.id);
    expect(reread?.status).toBe('archived');
  });

  it('does not archive fresh memories', async () => {
    const handle = await fixture();
    const repo = createMemoryRepository(handle.db, {
      clock: () => NOW as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write(baseInput, { actor });

    const stats = await compact(repo, { actor, now: NOW as never });
    expect(stats.archived).toBe(0);
  });

  it('does not archive a stale memory if it is younger than archiveAfter (even if confidence is low)', async () => {
    const handle = await fixture();
    // 200 days ago: factor ≈ 0.5^(200/90) ≈ 0.215; with stored
    // 0.1 → effective ≈ 0.0215, below archiveThreshold 0.05.
    // But 200 days < archiveAfter (365 days), so compact must
    // refuse to archive yet.
    const writeClock = isoDaysAgo(200);
    const repo = createMemoryRepository(handle.db, {
      clock: () => writeClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, storedConfidence: 0.1 }, { actor });

    const stats = await compact(repo, { actor, now: NOW as never });
    expect(stats.archived).toBe(0);
  });

  it('does not archive pinned memories — pinnedFloor protects them', async () => {
    const handle = await fixture();
    const writeClock = isoDaysAgo(5_000);
    const repo = createMemoryRepository(handle.db, {
      clock: () => writeClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const pinned = await repo.write({ ...baseInput, pinned: true }, { actor });

    const stats = await compact(repo, { actor, now: NOW as never });
    expect(stats.archived).toBe(0);

    const reread = await repo.read(pinned.id);
    expect(reread?.status).toBe('active');
    expect(reread?.pinned).toBe(true);
  });

  it('emits an archived event per archived memory', async () => {
    const handle = await fixture();
    const writeClock = isoDaysAgo(1_000);
    const repo = createMemoryRepository(handle.db, {
      clock: () => writeClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    const events = createEventRepository(handle.db);
    const stale = await repo.write({ ...baseInput, storedConfidence: 0.5 }, { actor });

    await compact(repo, { actor, now: NOW as never });

    const ev = await events.listForMemory(stale.id);
    const archivedEvents = ev.filter((e) => e.type === 'archived');
    expect(archivedEvents).toHaveLength(1);
    expect(archivedEvents[0]?.actor).toEqual(actor);
  });

  it('is idempotent — a second pass with the same clock archives nothing', async () => {
    const handle = await fixture();
    const writeClock = isoDaysAgo(1_000);
    const repo = createMemoryRepository(handle.db, {
      clock: () => writeClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    await repo.write({ ...baseInput, storedConfidence: 0.5 }, { actor });

    const first = await compact(repo, { actor, now: NOW as never });
    const second = await compact(repo, { actor, now: NOW as never });

    expect(first.archived).toBe(1);
    expect(second.archived).toBe(0);
  });

  it('compacts forgotten memories alongside active ones', async () => {
    const handle = await fixture();
    const writeClock = isoDaysAgo(1_000);
    const repo = createMemoryRepository(handle.db, {
      clock: () => writeClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });

    const a = await repo.write({ ...baseInput, storedConfidence: 0.5 }, { actor });
    await repo.forget(a.id, null, { actor });

    const stats = await compact(repo, { actor, now: NOW as never });

    expect(stats.archived).toBe(1);
    expect(stats.archivedIds).toEqual([a.id]);
    const archivedA = await repo.read(a.id);
    expect(archivedA?.status).toBe('archived');
  });

  it('does not touch superseded memories — they are excluded from compaction', async () => {
    const handle = await fixture();
    const writeClock = isoDaysAgo(1_000);
    const repo = createMemoryRepository(handle.db, {
      clock: () => writeClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });

    const original = await repo.write({ ...baseInput, storedConfidence: 0.5 }, { actor });
    await repo.supersede(
      original.id,
      { ...baseInput, storedConfidence: 0.5, content: 'replacement' },
      { actor },
    );

    await compact(repo, { actor, now: NOW as never });

    const reread = await repo.read(original.id);
    expect(reread?.status).toBe('superseded');
    expect(reread?.supersededBy).not.toBeNull();
  });
});
