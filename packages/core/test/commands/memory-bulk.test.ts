// Bulk-destructive command tests (`memory.forget_many`,
// `memory.archive_many`) per ADR-0014.
//
// Coverage:
//
// - Filter validation: empty filter rejected at parse.
// - Confirm gate: missing `confirm` rejected at parse.
// - Dry-run default: omitting `dryRun` runs the rehearsal,
//   touches no rows, returns the matched ids.
// - Apply path: real transitions land per-row, audit events
//   match a sequence of single-row calls.
// - Cap enforcement: `safety.bulkDestructiveLimit` rejects
//   over-cap applies; dry-run is uncapped.
// - Idempotence: archive_many re-run on already-archived
//   rows excludes them from the match set (status filter).
// - Filter scoping: scope+kind narrow correctly.

import type { ActorRef, MemoryEvent } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand } from '../../src/commands/execute.js';
import { createMemoryCommands } from '../../src/commands/memory/index.js';
import type { AnyCommand } from '../../src/commands/types.js';
import { type ConfigStore, createConfigStore } from '../../src/config/index.js';
import { createEventRepository } from '../../src/repository/event-repository.js';
import {
  type MemoryRepository,
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

const actor: ActorRef = { type: 'cli' };
const ctx = { actor };

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    const num = String(i).padStart(24, '0');
    return `${prefix}${num}`;
  };
}

const fixedClock = '2025-01-01T00:00:00.000Z';

async function fixture(opts?: { configStore?: ConfigStore }): Promise<{
  repo: MemoryRepository;
  byName: Map<string, AnyCommand>;
  eventRepo: ReturnType<typeof createEventRepository>;
}> {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  const repo = createMemoryRepository(handle.db, {
    clock: () => fixedClock as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const eventRepo = createEventRepository(handle.db);
  const commands = createMemoryCommands(repo, undefined, {
    eventRepository: eventRepo,
    ...(opts?.configStore !== undefined ? { configStore: opts.configStore } : {}),
  });
  const byName = new Map(commands.map((c) => [c.name, c]));
  return { repo, byName, eventRepo };
}

const baseWrite = {
  scope: { type: 'global' as const },
  owner: { type: 'local' as const, id: 'tester' },
  kind: { type: 'fact' as const },
  tags: [] as string[],
  pinned: false,
  summary: null,
  storedConfidence: 0.5,
};

function get(byName: Map<string, AnyCommand>, name: string): AnyCommand {
  const cmd = byName.get(name);
  if (cmd === undefined) {
    throw new Error(`missing command: ${name}`);
  }
  return cmd;
}

async function seedMemories(byName: Map<string, AnyCommand>, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = await executeCommand(
      get(byName, 'memory.write'),
      { ...baseWrite, content: `note ${i}` },
      ctx,
    );
    if (!r.ok) throw new Error(`seed failed: ${r.error.code}`);
    ids.push((r.value as { id: string }).id);
  }
  return ids;
}

describe('memory.forget_many', () => {
  it('rejects empty filter at INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: {}, reason: null, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing confirm at INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, reason: null },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('defaults to dryRun=true: previews the match set without touching rows', async () => {
    const { byName, eventRepo } = await fixture();
    const ids = await seedMemories(byName, 3);

    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, reason: 'sweep', confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      dryRun: boolean;
      matched: number;
      applied: number;
      ids: string[];
    };
    expect(value.dryRun).toBe(true);
    expect(value.matched).toBe(3);
    expect(value.applied).toBe(0);
    expect(value.ids.sort()).toEqual([...ids].sort());

    // No `forgotten` events were appended.
    const events = await eventRepo.listRecent({ types: ['forgotten'] });
    expect(events).toHaveLength(0);
  });

  it('applies real transitions and emits per-row forgotten events', async () => {
    const { byName, eventRepo } = await fixture();
    await seedMemories(byName, 3);

    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      {
        filter: { kind: 'fact' },
        reason: 'cleanup',
        dryRun: false,
        confirm: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { dryRun: boolean; applied: number; matched: number };
    expect(value.dryRun).toBe(false);
    expect(value.matched).toBe(3);
    expect(value.applied).toBe(3);

    const events = (await eventRepo.listRecent({ types: ['forgotten'] })) as MemoryEvent[];
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.type).toBe('forgotten');
      if (event.type === 'forgotten') {
        expect(event.payload.reason).toBe('cleanup');
      }
    }
  });

  it('rejects apply when matched > safety.bulkDestructiveLimit', async () => {
    const configStore = createConfigStore({ 'safety.bulkDestructiveLimit': 2 });
    const { byName } = await fixture({ configStore });
    await seedMemories(byName, 3);

    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      {
        filter: { kind: 'fact' },
        reason: null,
        dryRun: false,
        confirm: true,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('safety.bulkDestructiveLimit');
    expect(result.error.details).toEqual({ limit: 2, matched: 3 });
  });

  it('does not cap dry-run rehearsals: matched is reported even above limit', async () => {
    const configStore = createConfigStore({ 'safety.bulkDestructiveLimit': 1 });
    const { byName } = await fixture({ configStore });
    await seedMemories(byName, 3);

    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, reason: null, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; applied: number };
    expect(value.matched).toBe(3);
    expect(value.applied).toBe(0);
  });

  it('re-run on the same filter is a no-op (forgotten rows fall out of the active set)', async () => {
    const { byName } = await fixture();
    await seedMemories(byName, 2);

    const first = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, reason: null, dryRun: false, confirm: true },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((first.value as { applied: number }).applied).toBe(2);

    const second = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, reason: null, dryRun: false, confirm: true },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const value = second.value as { matched: number; applied: number };
    expect(value.matched).toBe(0);
    expect(value.applied).toBe(0);
  });

  it('applies with createdAtLte filter', async () => {
    const { byName } = await fixture();
    await seedMemories(byName, 2);

    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      {
        filter: { kind: 'fact', createdAtLte: '2025-01-02T00:00:00.000Z' },
        reason: null,
        dryRun: false,
        confirm: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; applied: number };
    expect(value.matched).toBe(2);
    expect(value.applied).toBe(2);
  });

  it('applies with scope and pinned filters', async () => {
    const { byName } = await fixture();
    await seedMemories(byName, 2);

    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      {
        filter: { kind: 'fact', scope: { type: 'global' }, pinned: false },
        reason: null,
        dryRun: false,
        confirm: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; applied: number };
    expect(value.matched).toBe(2);
    expect(value.applied).toBe(2);
  });

  it('scopes by kind: a non-matching kind leaves rows untouched', async () => {
    const { byName } = await fixture();
    // Seed two facts and one preference.
    await executeCommand(get(byName, 'memory.write'), { ...baseWrite, content: 'a' }, ctx);
    await executeCommand(get(byName, 'memory.write'), { ...baseWrite, content: 'b' }, ctx);
    await executeCommand(
      get(byName, 'memory.write'),
      { ...baseWrite, kind: { type: 'preference' as const }, content: 'c' },
      ctx,
    );

    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, reason: null, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { applied: number }).applied).toBe(2);

    // The preference row is still active.
    const list = await executeCommand(get(byName, 'memory.list'), { status: 'active' }, ctx);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const rows = list.value as { kind: { type: string } }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind.type).toBe('preference');
  });

  // bulk-forget by tag.
  it('narrows by `tags` filter (AND semantics) and only forgets the matched rows', async () => {
    const { byName } = await fixture();
    // Seed: 2 with tag-a only, 2 with tag-b only, 2 with both.
    for (let i = 0; i < 2; i += 1) {
      await executeCommand(
        get(byName, 'memory.write'),
        { ...baseWrite, content: `a-${i}`, tags: ['tag-a'] },
        ctx,
      );
    }
    for (let i = 0; i < 2; i += 1) {
      await executeCommand(
        get(byName, 'memory.write'),
        { ...baseWrite, content: `b-${i}`, tags: ['tag-b'] },
        ctx,
      );
    }
    for (let i = 0; i < 2; i += 1) {
      await executeCommand(
        get(byName, 'memory.write'),
        { ...baseWrite, content: `ab-${i}`, tags: ['tag-a', 'tag-b'] },
        ctx,
      );
    }

    // forget_many({tags: ['tag-a']}) → should match the 2 with tag-a only PLUS the 2 with both = 4.
    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { tags: ['tag-a'] }, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; applied: number };
    expect(value.matched).toBe(4);
    expect(value.applied).toBe(4);

    // The 2 tag-b-only rows are still active.
    const list = await executeCommand(get(byName, 'memory.list'), { status: 'active' }, ctx);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const rows = list.value as { tags: string[] }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tags).toEqual(['tag-b']);
    }
  });

  it('AND-combines tags + kind filters', async () => {
    const { byName } = await fixture();
    await executeCommand(
      get(byName, 'memory.write'),
      { ...baseWrite, content: 'fact-a', tags: ['target'] },
      ctx,
    );
    await executeCommand(
      get(byName, 'memory.write'),
      { ...baseWrite, content: 'fact-b', tags: ['target'], kind: { type: 'preference' } },
      ctx,
    );
    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { tags: ['target'], kind: 'fact' }, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; applied: number };
    expect(value.matched).toBe(1);
    expect(value.applied).toBe(1);
  });

  // `reason` is truly optional (used to be
  // schema-required even on dry-run).
  it('accepts dryRun=true without a `reason` field at all', async () => {
    const { byName } = await fixture();
    await seedMemories(byName, 2);
    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, dryRun: true, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { dryRun: boolean; matched: number; applied: number };
    expect(value.dryRun).toBe(true);
    expect(value.matched).toBe(2);
    expect(value.applied).toBe(0);
  });

  it('accepts apply path without a `reason` field — events record reason: null', async () => {
    const { byName, eventRepo } = await fixture();
    const ids = await seedMemories(byName, 1);
    const result = await executeCommand(
      get(byName, 'memory.forget_many'),
      { filter: { kind: 'fact' }, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    const events = await eventRepo.listForMemory(ids[0] as never, {
      types: ['forgotten'],
    });
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { reason: unknown }).reason).toBeNull();
  });
});

describe('memory.archive_many', () => {
  it('rejects empty filter at INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: {}, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects missing confirm at INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: { kind: 'fact' } },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('archives matching rows and emits per-row archived events', async () => {
    const { byName, eventRepo } = await fixture();
    await seedMemories(byName, 2);

    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: { kind: 'fact' }, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { applied: number; matched: number };
    expect(value.matched).toBe(2);
    expect(value.applied).toBe(2);

    const events = (await eventRepo.listRecent({ types: ['archived'] })) as MemoryEvent[];
    expect(events).toHaveLength(2);
  });

  it('re-run after archive sees zero matches (already-archived rows are filtered out)', async () => {
    const { byName } = await fixture();
    await seedMemories(byName, 2);

    const first = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: { kind: 'fact' }, dryRun: false, confirm: true },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((first.value as { applied: number }).applied).toBe(2);

    const second = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: { kind: 'fact' }, dryRun: false, confirm: true },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const value = second.value as { matched: number; applied: number };
    expect(value.matched).toBe(0);
    expect(value.applied).toBe(0);
  });

  it('rejects apply when matched > safety.bulkDestructiveLimit', async () => {
    const configStore = createConfigStore({ 'safety.bulkDestructiveLimit': 1 });
    const { byName } = await fixture({ configStore });
    await seedMemories(byName, 2);

    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: { kind: 'fact' }, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.details).toEqual({ limit: 1, matched: 2 });
  });

  it('defaults to dryRun=true: previews the match set without touching rows', async () => {
    const { byName } = await fixture();
    const ids = await seedMemories(byName, 2);

    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: { kind: 'fact' }, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {
      dryRun: boolean;
      matched: number;
      applied: number;
      ids: string[];
    };
    expect(value.dryRun).toBe(true);
    expect(value.matched).toBe(2);
    expect(value.applied).toBe(0);
    expect(value.ids.sort()).toEqual([...ids].sort());
  });

  it('applies with createdAtLte filter', async () => {
    const { byName } = await fixture();
    await seedMemories(byName, 2);

    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      {
        filter: { kind: 'fact', createdAtLte: '2025-01-02T00:00:00.000Z' },
        dryRun: false,
        confirm: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; applied: number };
    expect(value.matched).toBe(2);
    expect(value.applied).toBe(2);
  });

  it('applies with scope and pinned filters', async () => {
    const { byName } = await fixture();
    await seedMemories(byName, 2);

    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      {
        filter: { kind: 'fact', scope: { type: 'global' }, pinned: false },
        dryRun: false,
        confirm: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { matched: number; applied: number };
    expect(value.matched).toBe(2);
    expect(value.applied).toBe(2);
  });

  it('archives forgotten rows too (legal source statuses include forgotten)', async () => {
    const { byName } = await fixture();
    const ids = await seedMemories(byName, 1);
    await executeCommand(
      get(byName, 'memory.forget'),
      { id: ids[0], reason: null, confirm: true },
      ctx,
    );

    const result = await executeCommand(
      get(byName, 'memory.archive_many'),
      { filter: { kind: 'fact' }, dryRun: false, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { applied: number }).applied).toBe(1);
  });
});

describe('batch repo methods', () => {
  it('forgetBatch forgets multiple active memories and emits events', async () => {
    const { repo, eventRepo } = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await repo.write({ ...baseWrite, content: `note ${i}` }, ctx);
      ids.push(m.id as unknown as string);
    }

    const result = await repo.forgetBatch(
      ids as unknown as import('@psraghuveer/memento-schema').MemoryId[],
      'batch cleanup',
      ctx,
    );
    expect(result.applied).toBe(3);

    // Verify all memories are now forgotten.
    for (const id of ids) {
      const m = await repo.read(id as unknown as import('@psraghuveer/memento-schema').MemoryId);
      expect(m).not.toBeNull();
      expect(m!.status).toBe('forgotten');
    }

    // Verify forgotten events were emitted.
    const events = await eventRepo.listRecent({ types: ['forgotten'] });
    expect(events).toHaveLength(3);
  });

  it('archiveBatch archives multiple memories, skips already-archived', async () => {
    const { repo } = await fixture();
    const ids: import('@psraghuveer/memento-schema').MemoryId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await repo.write({ ...baseWrite, content: `note ${i}` }, ctx);
      ids.push(m.id);
    }

    // Archive the first one individually.
    await repo.archive(ids[0]!, ctx);

    // Batch-archive all three — the first should be silently skipped.
    const result = await repo.archiveBatch(ids, ctx);
    expect(result.applied).toBe(2);

    // All three should be archived.
    for (const id of ids) {
      const m = await repo.read(id);
      expect(m).not.toBeNull();
      expect(m!.status).toBe('archived');
    }
  });

  it('confirmBatch confirms multiple active memories', async () => {
    const { repo } = await fixture();
    const ids: import('@psraghuveer/memento-schema').MemoryId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await repo.write({ ...baseWrite, content: `note ${i}` }, ctx);
      ids.push(m.id);
    }

    const result = await repo.confirmBatch(ids, ctx);
    expect(result.applied).toBe(3);

    // All memories should still be active.
    for (const id of ids) {
      const m = await repo.read(id);
      expect(m).not.toBeNull();
      expect(m!.status).toBe('active');
    }
  });

  it('confirmBatch skips non-active memories and returns their ids', async () => {
    const { repo } = await fixture();
    const ids: import('@psraghuveer/memento-schema').MemoryId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await repo.write({ ...baseWrite, content: `note ${i}` }, ctx);
      ids.push(m.id);
    }

    // Forget the middle one so it's no longer active.
    await repo.forget(ids[1]!, null, ctx);

    const result = await repo.confirmBatch(ids, ctx);
    expect(result.applied).toBe(2);
    expect(result.skippedIds).toHaveLength(1);
    expect(result.skippedIds[0]).toBe(ids[1]);

    // The active ones were confirmed; the forgotten one is untouched.
    const first = await repo.read(ids[0]!);
    expect(first!.status).toBe('active');
    const second = await repo.read(ids[1]!);
    expect(second!.status).toBe('forgotten');
  });

  it('confirmBatch returns empty skippedIds when all succeed', async () => {
    const { repo } = await fixture();
    const m = await repo.write({ ...baseWrite, content: 'solo' }, ctx);
    const result = await repo.confirmBatch([m.id], ctx);
    expect(result.applied).toBe(1);
    expect(result.skippedIds).toHaveLength(0);
  });

  it('forgetBatch on non-active memory rolls back entire transaction', async () => {
    const { repo } = await fixture();
    const ids: import('@psraghuveer/memento-schema').MemoryId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await repo.write({ ...baseWrite, content: `note ${i}` }, ctx);
      ids.push(m.id);
    }

    // Forget the second one individually so it's no longer active.
    await repo.forget(ids[1]!, null, ctx);

    // forgetBatch should throw and roll back — none of the three
    // should be affected by the batch.
    await expect(repo.forgetBatch(ids, 'bad batch', ctx)).rejects.toThrow(
      /status=forgotten not in \[active\]/,
    );

    // The first memory should still be active (rollback).
    const first = await repo.read(ids[0]!);
    expect(first!.status).toBe('active');

    // The third memory should still be active (rollback).
    const third = await repo.read(ids[2]!);
    expect(third!.status).toBe('active');
  });
});
