// End-to-end tests for the `conflict.*`, `embedding.*`, and
// `compact.*` command sets.
//
// All three sets are exercised through `executeCommand` against
// in-memory SQLite, mirroring the `memory.*` test fixture style.

import type { ActorRef, MemoryId } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompactCommands } from '../../src/commands/compact/index.js';
import { createConflictCommands } from '../../src/commands/conflict/index.js';
import { createEmbeddingCommands } from '../../src/commands/embedding/index.js';
import { executeCommand } from '../../src/commands/execute.js';
import { createMemoryCommands } from '../../src/commands/memory/index.js';
import type { AnyCommand } from '../../src/commands/types.js';
import { createConflictRepository } from '../../src/conflict/repository.js';
import type { EmbeddingProvider } from '../../src/embedding/provider.js';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
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

class StubProvider implements EmbeddingProvider {
  readonly model = 'stub-v1';
  readonly dimension = 4;
  failOn: string | null = null;
  callCount = 0;

  async embed(text: string): Promise<readonly number[]> {
    this.callCount += 1;
    if (this.failOn !== null && text.includes(this.failOn)) {
      throw new Error(`stub provider rejected: ${text}`);
    }
    return [0.1, 0.2, 0.3, 0.4];
  }
}

async function fixture() {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  const memoryRepo = createMemoryRepository(handle.db, {
    clock: () => fixedClock as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const conflictRepo = createConflictRepository(handle.db, {
    clock: () => fixedClock as never,
    conflictIdFactory: counterFactory('C0') as never,
    eventIdFactory: counterFactory('CE'),
  });
  const provider = new StubProvider();

  const memoryCmds = createMemoryCommands(memoryRepo);
  const conflictCmds = createConflictCommands({
    conflictRepository: conflictRepo,
    memoryRepository: memoryRepo,
  });
  const embeddingCmds = createEmbeddingCommands({
    memoryRepository: memoryRepo,
    provider,
  });
  const compactCmds = createCompactCommands({ memoryRepository: memoryRepo });

  const byName = new Map<string, AnyCommand>(
    [...memoryCmds, ...conflictCmds, ...embeddingCmds, ...compactCmds].map(
      (c) => [c.name, c] as const,
    ),
  );
  return { memoryRepo, conflictRepo, provider, byName };
}

function get(byName: Map<string, AnyCommand>, name: string): AnyCommand {
  const cmd = byName.get(name);
  if (cmd === undefined) {
    throw new Error(`missing command: ${name}`);
  }
  return cmd;
}

const prefInput = {
  scope: { type: 'global' as const },
  owner: { type: 'local' as const, id: 'tester' },
  kind: { type: 'preference' as const },
  tags: [],
  pinned: false,
  content: 'tabs: yes',
  summary: null,
  storedConfidence: 1,
};

async function writeMemory(
  byName: Map<string, AnyCommand>,
  overrides: Partial<typeof prefInput> = {},
): Promise<MemoryId> {
  const res = await executeCommand(
    get(byName, 'memory.write'),
    { ...prefInput, ...overrides },
    ctx,
  );
  if (!res.ok) {
    throw new Error(`fixture memory.write failed: ${res.error.code}`);
  }
  return res.value.id as MemoryId;
}

describe('createConflictCommands', () => {
  it('exposes the v1 conflict.* set under both surfaces', async () => {
    const { byName } = await fixture();
    const names = [
      'conflict.read',
      'conflict.list',
      'conflict.events',
      'conflict.resolve',
      'conflict.scan',
    ];
    for (const name of names) {
      const cmd = get(byName, name);
      expect(cmd.surfaces).toEqual(['mcp', 'cli']);
    }
  });

  it('classifies side-effects per the documented matrix', async () => {
    const { byName } = await fixture();
    expect(get(byName, 'conflict.read').sideEffect).toBe('read');
    expect(get(byName, 'conflict.list').sideEffect).toBe('read');
    expect(get(byName, 'conflict.events').sideEffect).toBe('read');
    expect(get(byName, 'conflict.resolve').sideEffect).toBe('write');
    expect(get(byName, 'conflict.scan').sideEffect).toBe('write');
  });

  it('scans, reads, lists, events, and resolves a conflict end-to-end', async () => {
    const { byName } = await fixture();
    const aId = await writeMemory(byName);
    const bId = await writeMemory(byName, { content: 'tabs: no' });

    const scan = await executeCommand(
      get(byName, 'conflict.scan'),
      { mode: 'memory', memoryId: bId },
      ctx,
    );
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.value.opened).toHaveLength(1);
    const conflictId = scan.value.opened[0]?.id;
    if (conflictId === undefined) throw new Error('expected conflictId');

    const read = await executeCommand(get(byName, 'conflict.read'), { id: conflictId }, ctx);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value?.newMemoryId).toBe(bId);
    expect(read.value?.conflictingMemoryId).toBe(aId);

    const list = await executeCommand(get(byName, 'conflict.list'), { open: true }, ctx);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(1);

    const events = await executeCommand(get(byName, 'conflict.events'), { id: conflictId }, ctx);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(1);
    expect(events.value[0]?.type).toBe('opened');

    const resolve = await executeCommand(
      get(byName, 'conflict.resolve'),
      { id: conflictId, resolution: 'accept-new' },
      ctx,
    );
    expect(resolve.ok).toBe(true);
    if (!resolve.ok) return;
    expect(resolve.value.resolution).toBe('accept-new');
  });

  it('returns CONFLICT when resolving a conflict twice', async () => {
    const { byName } = await fixture();
    const aId = await writeMemory(byName);
    void aId;
    const bId = await writeMemory(byName, { content: 'tabs: no' });
    const scan = await executeCommand(
      get(byName, 'conflict.scan'),
      { mode: 'memory', memoryId: bId },
      ctx,
    );
    if (!scan.ok) throw new Error('scan failed');
    const conflictId = scan.value.opened[0]?.id;
    if (conflictId === undefined) throw new Error('no conflict');

    await executeCommand(
      get(byName, 'conflict.resolve'),
      { id: conflictId, resolution: 'accept-new' },
      ctx,
    );
    const second = await executeCommand(
      get(byName, 'conflict.resolve'),
      { id: conflictId, resolution: 'accept-existing' },
      ctx,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('CONFLICT');
  });

  it('returns NOT_FOUND when scanning an unknown memory', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'conflict.scan'),
      { mode: 'memory', memoryId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_INPUT for an empty scopes array on scan', async () => {
    const { byName } = await fixture();
    const id = await writeMemory(byName);
    const result = await executeCommand(
      get(byName, 'conflict.scan'),
      { mode: 'memory', memoryId: id, scopes: [] },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('replays detection over the historical window in `since` mode', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    await writeMemory(byName, { content: 'tabs: no' });

    const result = await executeCommand(
      get(byName, 'conflict.scan'),
      { mode: 'since', since: '2024-01-01T00:00:00.000Z' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both memories are scanned; the second one opens a
    // conflict against the first.
    expect(result.value.scanned).toBeGreaterThanOrEqual(2);
    expect(result.value.opened.length).toBeGreaterThanOrEqual(1);
  });

  it('skips the historical window when `since` is in the future', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    await writeMemory(byName, { content: 'tabs: no' });

    const result = await executeCommand(
      get(byName, 'conflict.scan'),
      { mode: 'since', since: '2099-01-01T00:00:00.000Z' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(0);
    expect(result.value.opened).toEqual([]);
  });

  it('rejects scan input lacking a discriminator as INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'conflict.scan'),
      { memoryId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('createEmbeddingCommands', () => {
  it('exposes embedding.rebuild as an admin command on both surfaces', async () => {
    const { byName } = await fixture();
    const cmd = get(byName, 'embedding.rebuild');
    expect(cmd.sideEffect).toBe('admin');
    expect(cmd.surfaces).toEqual(['mcp', 'cli']);
  });

  it('embeds active memories and reports counts', async () => {
    const { byName } = await fixture();
    await writeMemory(byName, { content: 'one' });
    await writeMemory(byName, { content: 'two' });

    const result = await executeCommand(get(byName, 'embedding.rebuild'), { confirm: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(2);
    expect(result.value.embedded).toHaveLength(2);
    expect(result.value.skipped).toHaveLength(0);
  });

  it('records provider failures as `error` skips without halting the batch', async () => {
    const { byName, provider } = await fixture();
    await writeMemory(byName, { content: 'good one' });
    await writeMemory(byName, { content: 'fail-me please' });
    provider.failOn = 'fail-me';

    const result = await executeCommand(get(byName, 'embedding.rebuild'), { confirm: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(2);
    expect(result.value.embedded).toHaveLength(1);
    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.skipped[0]?.reason).toBe('error');
    expect(result.value.skipped[0]?.errorMessage).toContain('stub provider rejected');
  });

  it('rejects an out-of-range batchSize as INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'embedding.rebuild'),
      { batchSize: 0, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('createCompactCommands', () => {
  it('exposes compact.run as an admin command on both surfaces', async () => {
    const { byName } = await fixture();
    const cmd = get(byName, 'compact.run');
    expect(cmd.sideEffect).toBe('admin');
    expect(cmd.surfaces).toEqual(['mcp', 'cli']);
  });

  it('returns a structured stats result on a fresh database', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);

    const result = await executeCommand(get(byName, 'compact.run'), { confirm: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A freshly-written memory at the fixed clock has not aged
    // past the archive threshold, so nothing is archived.
    expect(result.value.archived).toBe(0);
    expect(result.value.archivedIds).toEqual([]);
    expect(result.value.scanned).toBeGreaterThanOrEqual(1);
  });

  it('rejects an out-of-range batchSize as INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(
      get(byName, 'compact.run'),
      { batchSize: -1, confirm: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

// Confirm-gate (ADR-0012). Each destructive command must
// require `confirm: z.literal(true)`. Missing or `false` must
// surface as INVALID_INPUT before the handler runs.
describe('confirm gate (ADR-0012)', () => {
  it('embedding.rebuild rejects when confirm is missing', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    const result = await executeCommand(get(byName, 'embedding.rebuild'), {}, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('embedding.rebuild rejects when confirm is false', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    const result = await executeCommand(get(byName, 'embedding.rebuild'), { confirm: false }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('compact.run rejects when confirm is missing', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    const result = await executeCommand(get(byName, 'compact.run'), {}, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('compact.run rejects when confirm is false', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    const result = await executeCommand(get(byName, 'compact.run'), { confirm: false }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});
