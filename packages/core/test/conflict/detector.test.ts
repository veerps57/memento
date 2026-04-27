import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { detectConflicts } from '../../src/conflict/detector.js';
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
  const memoryRepo = createMemoryRepository(handle.db, {
    clock: () => '2025-01-01T00:00:00.000Z' as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const conflictRepo = createConflictRepository(handle.db, {
    clock: () => '2025-01-01T00:00:00.000Z' as never,
    conflictIdFactory: counterFactory('C0') as never,
    eventIdFactory: counterFactory('CE'),
  });
  return { handle, memoryRepo, conflictRepo };
}

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    const num = String(i).padStart(24, '0');
    return `${prefix}${num}`;
  };
}

const actor: ActorRef = { type: 'cli' };

const baseInput: MemoryWriteInput = {
  scope: { type: 'global' },
  owner: { type: 'local', id: 'tester' },
  kind: { type: 'preference' },
  tags: [],
  pinned: false,
  content: 'tabs: yes',
  summary: null,
  storedConfidence: 1,
};

describe('detectConflicts', () => {
  it('opens a conflict for a same-key/different-value preference', async () => {
    const { memoryRepo, conflictRepo } = await fixture();
    const a = await memoryRepo.write(baseInput, { actor });
    const b = await memoryRepo.write({ ...baseInput, content: 'tabs: no' }, { actor });

    const result = await detectConflicts(
      b,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      { actor },
    );

    expect(result.opened).toHaveLength(1);
    const opened = result.opened[0];
    if (opened === undefined) {
      throw new Error('expected one conflict');
    }
    expect(opened.newMemoryId).toBe(b.id);
    expect(opened.conflictingMemoryId).toBe(a.id);
    expect(opened.kind).toBe('preference');
    // scanned counts both candidates returned by list (both are
    // active, both same-kind), but the policy short-circuits on
    // `id === id` so we don't re-flag the writer against itself.
    expect(result.scanned).toBe(2);
  });

  it('does not flag the writer against itself', async () => {
    const { memoryRepo, conflictRepo } = await fixture();
    const a = await memoryRepo.write(baseInput, { actor });
    const result = await detectConflicts(
      a,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      { actor },
    );
    expect(result.opened).toEqual([]);
  });

  it('skips memories of a different kind', async () => {
    const { memoryRepo, conflictRepo } = await fixture();
    await memoryRepo.write(
      { ...baseInput, kind: { type: 'fact' }, content: 'tabs: yes' },
      { actor },
    );
    const b = await memoryRepo.write(baseInput, { actor });
    const result = await detectConflicts(
      b,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      { actor },
    );
    expect(result.opened).toEqual([]);
  });

  it('skips superseded candidates (status filter)', async () => {
    const { memoryRepo, conflictRepo } = await fixture();
    const a = await memoryRepo.write(baseInput, { actor });
    // supersede a with a new content that does NOT conflict with our writer.
    await memoryRepo.supersede(a.id, { ...baseInput, content: 'tabs: yes' }, { actor });
    // Now write a fresh memory that would conflict with `a` if `a` were active.
    const c = await memoryRepo.write({ ...baseInput, content: 'tabs: no' }, { actor });
    const result = await detectConflicts(
      c,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      { actor },
    );
    // The original `a` is now superseded; its replacement says
    // `tabs: yes` which conflicts with `c`. Exactly one conflict.
    expect(result.opened).toHaveLength(1);
    const opened = result.opened[0];
    if (opened === undefined) {
      throw new Error('expected a conflict');
    }
    expect(opened.conflictingMemoryId).not.toBe(a.id);
  });

  it('does not open a conflict when next supersedes candidate', async () => {
    const { memoryRepo, conflictRepo } = await fixture();
    const a = await memoryRepo.write(baseInput, { actor });
    // supersede emits the new memory whose `supersedes === a.id`.
    const { current } = await memoryRepo.supersede(
      a.id,
      { ...baseInput, content: 'tabs: no' },
      { actor },
    );
    const result = await detectConflicts(
      current,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      { actor },
    );
    expect(result.opened).toEqual([]);
  });

  it('respects custom scopes (effective-scope strategy)', async () => {
    const { memoryRepo, conflictRepo } = await fixture();
    await memoryRepo.write(
      {
        ...baseInput,
        scope: { type: 'workspace', path: '/tmp/p1' as never },
        content: 'tabs: no',
      },
      { actor },
    );
    const b = await memoryRepo.write(
      { ...baseInput, scope: { type: 'global' }, content: 'tabs: yes' },
      { actor },
    );
    // Same-scope strategy: no conflict (b is global, a is in workspace).
    const sameScope = await detectConflicts(
      b,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      { actor },
    );
    expect(sameScope.opened).toEqual([]);

    // Effective-scope strategy: conflict surfaces when both are scanned.
    const effective = await detectConflicts(
      b,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      {
        actor,
        scopes: [{ type: 'global' }, { type: 'workspace', path: '/tmp/p1' as never }],
      },
    );
    expect(effective.opened).toHaveLength(1);
  });
});
