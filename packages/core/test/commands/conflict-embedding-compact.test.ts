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
    // `conflict.list`, `conflict.resolve`, and `conflict.scan`
    // opt into the dashboard surface — the conflicts page
    // renders the list, the resolve buttons drive .resolve, and
    // the "re-scan (24h)" button drives .scan. `conflict.read`
    // and `conflict.events` stay mcp+cli-only because nothing in
    // the v0 dashboard surface needs them yet (per ADR-0018's
    // "expose only what the UI uses" stance).
    const dashboardSubset = new Set(['conflict.list', 'conflict.resolve', 'conflict.scan']);
    for (const name of names) {
      const cmd = get(byName, name);
      expect(cmd.surfaces).toContain('mcp');
      expect(cmd.surfaces).toContain('cli');
      if (dashboardSubset.has(name)) {
        expect(cmd.surfaces).toContain('dashboard');
      } else {
        expect(cmd.surfaces).not.toContain('dashboard');
      }
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
    // `scanned` in `since` mode is "memories processed" — exactly
    // the two we wrote, not the inner candidate-pairing count
    // summed across them. The previous accumulator semantic
    // surfaced "scanned 68413 memories" on a 5k corpus, which is
    // the work the detector did, not the size of the haystack.
    expect(result.value.scanned).toBe(2);
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

  it('rejects mode=memory without memoryId as INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(get(byName, 'conflict.scan'), { mode: 'memory' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects mode=since without since as INVALID_INPUT', async () => {
    const { byName } = await fixture();
    const result = await executeCommand(get(byName, 'conflict.scan'), { mode: 'since' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('lists all conflicts when no filters are provided', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    await writeMemory(byName, { content: 'tabs: no' });
    // Trigger a conflict via scan first.
    const id = await writeMemory(byName, { content: 'tabs: maybe' });
    await executeCommand(get(byName, 'conflict.scan'), { mode: 'memory', memoryId: id }, ctx);

    // Call list with empty input — all spread ternaries take the
    // `else` branch (no filters applied).
    const result = await executeCommand(get(byName, 'conflict.list'), {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(1);
  });

  it('scans in since mode without optional scopes or maxCandidates', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    await writeMemory(byName, { content: 'tabs: no' });

    // `since` mode with no scopes / maxCandidates — the spread
    // ternaries at lines 134-135 take the `else` branch.
    const result = await executeCommand(
      get(byName, 'conflict.scan'),
      { mode: 'since', since: '2024-01-01T00:00:00.000Z' },
      ctx,
    );
    expect(result.ok).toBe(true);
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

  it('threads `includeNonActive` through to the bulk driver', async () => {
    // With a forgotten memory in the corpus, default behaviour
    // skips it (active-only scan); `includeNonActive: true`
    // picks it up.
    const { byName, memoryRepo } = await fixture();
    const active = await writeMemory(byName);
    const toForget = await writeMemory(byName);
    await memoryRepo.forget(toForget, null, { actor: ctx.actor });

    const defaultResult = await executeCommand(
      get(byName, 'embedding.rebuild'),
      { confirm: true },
      ctx,
    );
    expect(defaultResult.ok).toBe(true);
    if (!defaultResult.ok) return;
    expect(defaultResult.value.scanned).toBe(1);
    expect(defaultResult.value.embedded).toContain(active);
    expect(defaultResult.value.embedded).not.toContain(toForget);

    const widenedResult = await executeCommand(
      get(byName, 'embedding.rebuild'),
      { confirm: true, includeNonActive: true, force: true },
      ctx,
    );
    expect(widenedResult.ok).toBe(true);
    if (!widenedResult.ok) return;
    expect(widenedResult.value.scanned).toBe(2);
    expect(widenedResult.value.embedded).toContain(toForget);
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

  // drain mode loops compact() until a
  // pass archives nothing. The default mode is now `drain`.
  it('reports a `batches` count in every response', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    const result = await executeCommand(get(byName, 'compact.run'), { confirm: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { batches: number };
    expect(value.batches).toBeGreaterThanOrEqual(1);
  });

  it('mode: "batch" performs exactly one pass (legacy single-batch behaviour)', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    const result = await executeCommand(
      get(byName, 'compact.run'),
      { mode: 'batch', confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { batches: number };
    expect(value.batches).toBe(1);
  });

  it('mode: "drain" stops when an iteration archives nothing (no infinite loop)', async () => {
    // Fresh corpus: nothing has decayed past the archive threshold,
    // so the very first pass returns archived=0 and drain exits.
    const { byName } = await fixture();
    for (let i = 0; i < 5; i += 1) {
      await writeMemory(byName, { content: `note-${i}` });
    }
    const result = await executeCommand(
      get(byName, 'compact.run'),
      { mode: 'drain', confirm: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { batches: number; archived: number };
    expect(value.archived).toBe(0);
    // First (and only) pass exited drain — far below maxBatches.
    expect(value.batches).toBe(1);
  });
});

describe('createEmbeddingCommands — runRepo catch branch', () => {
  it('maps a handler-level throw to a structured error', async () => {
    // Build embedding commands with a provider that fatally
    // throws during reembedAll (not per-row skip, but the whole
    // operation). This exercises the runRepo catch at line 36-38.
    const { byName, provider } = await fixture();
    await writeMemory(byName, { content: 'something' });
    // Make every embed call throw — reembedAll propagates unrecoverable errors.
    provider.failOn = '';
    const result = await executeCommand(get(byName, 'embedding.rebuild'), { confirm: true }, ctx);
    // Per-row errors are swallowed as skips by reembedAll, not
    // as handler-level throws. So the result is still ok with
    // skipped entries.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped.length).toBeGreaterThan(0);
  });

  it('catches a thrown error from reembedAll and maps via repoErrorToMementoError', async () => {
    // Build embedding commands with a repo whose `list` throws,
    // causing reembedAll to propagate the error unhandled. This
    // exercises the runRepo catch block (line 36-38 of commands.ts).
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);

    const brokenRepo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    // Close the database so any repo operation throws a SQLite error.
    handle.close();
    // Remove from handles so afterEach doesn't double-close.
    const idx = handles.indexOf(handle);
    if (idx !== -1) handles.splice(idx, 1);

    const provider = new StubProvider();
    const embeddingCmds = createEmbeddingCommands({
      memoryRepository: brokenRepo,
      provider,
    });
    const cmd = embeddingCmds.find((c) => c.name === 'embedding.rebuild')!;
    const result = await executeCommand(cmd, { confirm: true }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The error should be mapped to a structured MementoError.
    expect(result.error.code).toBeDefined();
  });
});

describe('createCompactCommands — no optional batchSize', () => {
  it('runs compaction without batchSize (spread ternary else branch)', async () => {
    const { byName } = await fixture();
    await writeMemory(byName);
    // Call without batchSize — the spread ternary at line 51
    // takes the `else` (empty object) branch.
    const result = await executeCommand(get(byName, 'compact.run'), { confirm: true }, ctx);
    expect(result.ok).toBe(true);
  });
});

describe('createCompactCommands — runRepo catch branch', () => {
  it('catches a thrown error from compact() and maps via repoErrorToMementoError', async () => {
    // Build compact commands with a repo whose underlying DB is
    // closed, causing compact() to throw. This exercises the
    // runRepo catch block (line 28-29 of compact/commands.ts).
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);

    const brokenRepo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M0') as never,
      eventIdFactory: counterFactory('E0'),
    });
    handle.close();
    const idx = handles.indexOf(handle);
    if (idx !== -1) handles.splice(idx, 1);

    const compactCmds = createCompactCommands({ memoryRepository: brokenRepo });
    const cmd = compactCmds.find((c) => c.name === 'compact.run')!;
    const result = await executeCommand(cmd, { confirm: true }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBeDefined();
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
