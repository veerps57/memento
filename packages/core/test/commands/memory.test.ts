// End-to-end tests for the `memory.*` command set.
//
// Each test exercises the public `executeCommand` path, since
// that is exactly how MCP and CLI adapters will invoke commands.
// The repository runs against an in-memory SQLite database from
// `openDatabase({ path: ':memory:' })` so we cover the
// happy-path SQL + the error-mapping path with one set of
// fixtures.

import type {
  ActorRef,
  Memory,
  MemoryEvent,
  MemoryId,
  MemoryView,
} from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand } from '../../src/commands/execute.js';
import { createMemoryCommands } from '../../src/commands/memory/index.js';
import type { AnyCommand } from '../../src/commands/types.js';
import { createConfigStore } from '../../src/config/index.js';
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

async function fixture(opts?: {
  configOverrides?: Parameters<typeof createConfigStore>[0];
}): Promise<{
  repo: MemoryRepository;
  byName: Map<string, AnyCommand>;
  configStore: ReturnType<typeof createConfigStore>;
}> {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  const repo = createMemoryRepository(handle.db, {
    clock: () => fixedClock as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const configStore = createConfigStore(opts?.configOverrides);
  const commands = createMemoryCommands(repo, undefined, { configStore });
  const byName = new Map(commands.map((c) => [c.name, c]));
  return { repo, byName, configStore };
}

const writeInput = {
  scope: { type: 'global' as const },
  owner: { type: 'local' as const, id: 'tester' },
  kind: { type: 'fact' as const },
  tags: ['Hello', 'world'],
  pinned: false,
  content: 'the meeting starts at 10am',
  summary: null,
  storedConfidence: 0.9,
};

function get(byName: Map<string, AnyCommand>, name: string): AnyCommand {
  const cmd = byName.get(name);
  if (cmd === undefined) {
    throw new Error(`missing command: ${name}`);
  }
  return cmd;
}

describe('createMemoryCommands', () => {
  it('exposes exactly the v1 memory.* set under both surfaces', async () => {
    const { byName } = await fixture();
    const expected = [
      'memory.read',
      'memory.list',
      'memory.write',
      'memory.write_many',
      'memory.supersede',
      'memory.confirm',
      'memory.confirm_many',
      'memory.update',
      'memory.restore',
      'memory.forget',
      'memory.archive',
      'memory.forget_many',
      'memory.archive_many',
      'memory.set_embedding',
    ];
    expect([...byName.keys()].sort()).toEqual([...expected].sort());
    // Every memory.* command exposes mcp + cli; the
    // dashboard-eligible subset additionally includes 'dashboard'.
    // New commands default to mcp+cli only — adding to the
    // dashboard surface is an explicit per-command decision.
    const dashboardSubset = new Set([
      'memory.read',
      'memory.list',
      'memory.events',
      'memory.confirm',
      'memory.update',
      'memory.forget',
    ]);
    for (const cmd of byName.values()) {
      expect(cmd.surfaces).toContain('mcp');
      expect(cmd.surfaces).toContain('cli');
      if (dashboardSubset.has(cmd.name)) {
        expect(cmd.surfaces).toContain('dashboard');
      } else {
        expect(cmd.surfaces).not.toContain('dashboard');
      }
    }
  });

  it('classifies side-effects per the documented matrix', async () => {
    const { byName } = await fixture();
    expect(get(byName, 'memory.read').sideEffect).toBe('read');
    expect(get(byName, 'memory.list').sideEffect).toBe('read');
    expect(get(byName, 'memory.write').sideEffect).toBe('write');
    expect(get(byName, 'memory.write_many').sideEffect).toBe('write');
    expect(get(byName, 'memory.supersede').sideEffect).toBe('write');
    expect(get(byName, 'memory.confirm').sideEffect).toBe('write');
    expect(get(byName, 'memory.confirm_many').sideEffect).toBe('write');
    expect(get(byName, 'memory.update').sideEffect).toBe('write');
    expect(get(byName, 'memory.restore').sideEffect).toBe('write');
    expect(get(byName, 'memory.forget').sideEffect).toBe('destructive');
    expect(get(byName, 'memory.archive').sideEffect).toBe('destructive');
    expect(get(byName, 'memory.forget_many').sideEffect).toBe('destructive');
    expect(get(byName, 'memory.archive_many').sideEffect).toBe('destructive');
    expect(get(byName, 'memory.set_embedding').sideEffect).toBe('admin');
  });

  describe('memory.write', () => {
    it('writes a memory and returns the canonical entity', async () => {
      const { byName } = await fixture();
      const cmd = get(byName, 'memory.write');
      const result = await executeCommand(cmd, writeInput, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('active');
      expect(result.value.tags).toEqual(['hello', 'world']);
      expect(result.value.createdAt).toBe(fixedClock);
    });

    it('returns INVALID_INPUT for malformed input (extra key)', async () => {
      const { byName } = await fixture();
      const cmd = get(byName, 'memory.write');
      const result = await executeCommand(cmd, { ...writeInput, surprise: true }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('returns INVALID_INPUT for storedConfidence out of range', async () => {
      const { byName } = await fixture();
      const cmd = get(byName, 'memory.write');
      const result = await executeCommand(cmd, { ...writeInput, storedConfidence: 1.5 }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    // End-to-end coverage of `enforceSafetyCaps` through the
    // command boundary. The helper itself is unit-tested
    // separately; this test pins the call-site so a future
    // refactor that drops the call (without touching the helper)
    // still fails.
    it('returns INVALID_INPUT when content exceeds safety.memoryContentMaxBytes', async () => {
      const { byName } = await fixture({
        configOverrides: { 'safety.memoryContentMaxBytes': 1024 },
      });
      const cmd = get(byName, 'memory.write');
      const result = await executeCommand(cmd, { ...writeInput, content: 'a'.repeat(2048) }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/safety\.memoryContentMaxBytes/u);
    });

    it('returns INVALID_INPUT when summary exceeds safety.summaryMaxBytes', async () => {
      const { byName } = await fixture({
        configOverrides: { 'safety.summaryMaxBytes': 64 },
      });
      const cmd = get(byName, 'memory.write');
      const result = await executeCommand(cmd, { ...writeInput, summary: 'a'.repeat(128) }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/safety\.summaryMaxBytes/u);
    });
  });

  describe('memory.read / memory.list', () => {
    it('reads an existing memory and returns null for a miss', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      expect(writeRes.ok).toBe(true);
      if (!writeRes.ok) return;
      const id = writeRes.value.id;

      const hit = await executeCommand(get(byName, 'memory.read'), { id }, ctx);
      expect(hit.ok).toBe(true);
      if (!hit.ok) return;
      expect(hit.value?.id).toBe(id);

      const miss = await executeCommand(
        get(byName, 'memory.read'),
        { id: `M0${'0'.repeat(23)}Z` },
        ctx,
      );
      expect(miss.ok).toBe(true);
      if (!miss.ok) return;
      expect(miss.value).toBeNull();
    });

    it('lists memories and accepts an empty filter', async () => {
      const { byName } = await fixture();
      await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: 'second one' },
        ctx,
      );
      const list = await executeCommand(get(byName, 'memory.list'), {}, ctx);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(2);
    });

    it('applies kind + scope filters', async () => {
      const { byName } = await fixture();
      await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      await executeCommand(
        get(byName, 'memory.write'),
        {
          ...writeInput,
          kind: { type: 'preference' as const },
          content: 'pref',
        },
        ctx,
      );
      const factsOnly = await executeCommand(get(byName, 'memory.list'), { kind: 'fact' }, ctx);
      expect(factsOnly.ok).toBe(true);
      if (!factsOnly.ok) return;
      expect(factsOnly.value).toHaveLength(1);
      expect(factsOnly.value[0]?.kind.type).toBe('fact');
    });

    it('rejects invalid limit at INVALID_INPUT', async () => {
      const { byName } = await fixture();
      const result = await executeCommand(get(byName, 'memory.list'), { limit: -3 }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('filters by tags (AND logic)', async () => {
      const { byName } = await fixture();
      await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, tags: ['arch', 'config'], content: 'tagged both' },
        ctx,
      );
      await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, tags: ['arch'], content: 'tagged arch only' },
        ctx,
      );
      await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, tags: ['unrelated'], content: 'no match' },
        ctx,
      );

      // Single tag filter
      const archOnly = await executeCommand(get(byName, 'memory.list'), { tags: ['arch'] }, ctx);
      expect(archOnly.ok).toBe(true);
      if (!archOnly.ok) return;
      expect(archOnly.value).toHaveLength(2);

      // AND logic: both tags required
      const both = await executeCommand(
        get(byName, 'memory.list'),
        { tags: ['arch', 'config'] },
        ctx,
      );
      expect(both.ok).toBe(true);
      if (!both.ok) return;
      expect(both.value).toHaveLength(1);
      expect(both.value[0]?.content).toBe('tagged both');
    });

    it('normalises tag filter to lowercase', async () => {
      const { byName } = await fixture();
      await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, tags: ['MyTag'], content: 'case test' },
        ctx,
      );

      const result = await executeCommand(get(byName, 'memory.list'), { tags: ['MYTAG'] }, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
    });
  });

  describe('memory.list includeEmbedding', () => {
    it('strips embedding by default', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      await executeCommand(
        get(byName, 'memory.set_embedding'),
        { id: writeRes.value.id, model: 'test', dimension: 3, vector: [0.1, 0.2, 0.3] },
        ctx,
      );

      const list = await executeCommand(get(byName, 'memory.list'), {}, ctx);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value[0]?.embedding).toBeNull();
    });

    it('includes embedding when includeEmbedding is true', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      await executeCommand(
        get(byName, 'memory.set_embedding'),
        { id: writeRes.value.id, model: 'test', dimension: 3, vector: [0.1, 0.2, 0.3] },
        ctx,
      );

      const list = await executeCommand(
        get(byName, 'memory.list'),
        { includeEmbedding: true },
        ctx,
      );
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value[0]?.embedding).not.toBeNull();
      expect(list.value[0]?.embedding?.dimension).toBe(3);
    });
  });

  // Pinned by the persona-3 lean-response pass: every single-memory
  // command's wire output strips the raw 768-float embedding (the
  // assistant almost never needs it; carrying it inflates context
  // for free) and instead exposes a small `embeddingStatus` enum
  // — `'present'` / `'pending'` / `'disabled'` — so the assistant
  // can still tell whether the vector exists. `memory.read` is
  // the one opt-in path back to the raw vector. These tests pin
  // both sides so a future "let's just always include the vector"
  // refactor fails loudly.
  describe('embeddingStatus + lean responses', () => {
    it('write returns embedding=null and embeddingStatus=disabled when vector retrieval is off', async () => {
      const { byName } = await fixture({
        configOverrides: { 'retrieval.vector.enabled': false },
      });
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      expect(writeRes.ok).toBe(true);
      if (!writeRes.ok) return;
      expect(writeRes.value.embedding).toBeNull();
      expect(writeRes.value.embeddingStatus).toBe('disabled');
    });

    it('write returns embedding=null and embeddingStatus=pending when vector is on but the embedder has not run', async () => {
      const { byName } = await fixture({
        configOverrides: { 'retrieval.vector.enabled': true },
      });
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      expect(writeRes.ok).toBe(true);
      if (!writeRes.ok) return;
      expect(writeRes.value.embedding).toBeNull();
      expect(writeRes.value.embeddingStatus).toBe('pending');
    });

    it('read defaults to stripped output; opts back in via includeEmbedding=true', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      await executeCommand(
        get(byName, 'memory.set_embedding'),
        { id: writeRes.value.id, model: 'test', dimension: 3, vector: [0.1, 0.2, 0.3] },
        ctx,
      );

      const stripped = await executeCommand(
        get(byName, 'memory.read'),
        { id: writeRes.value.id },
        ctx,
      );
      expect(stripped.ok).toBe(true);
      if (!stripped.ok) return;
      expect(stripped.value?.embedding).toBeNull();
      expect(stripped.value?.embeddingStatus).toBe('present');

      const full = await executeCommand(
        get(byName, 'memory.read'),
        { id: writeRes.value.id, includeEmbedding: true },
        ctx,
      );
      expect(full.ok).toBe(true);
      if (!full.ok) return;
      expect(full.value?.embedding?.dimension).toBe(3);
      expect(full.value?.embeddingStatus).toBe('present');
    });

    it('confirm / update / forget / restore / archive all strip the embedding by default', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const id = writeRes.value.id;
      await executeCommand(
        get(byName, 'memory.set_embedding'),
        { id, model: 'test', dimension: 3, vector: [0.1, 0.2, 0.3] },
        ctx,
      );

      // confirm
      const confirmed = await executeCommand(get(byName, 'memory.confirm'), { id }, ctx);
      expect(confirmed.ok && confirmed.value.embedding).toBeNull();

      // update (taxonomy-only)
      const updated = await executeCommand(
        get(byName, 'memory.update'),
        { id, patch: { pinned: true } },
        ctx,
      );
      expect(updated.ok && updated.value.embedding).toBeNull();

      // forget
      const forgotten = await executeCommand(
        get(byName, 'memory.forget'),
        { id, confirm: true, reason: 'persona-3 test' },
        ctx,
      );
      expect(forgotten.ok && forgotten.value.embedding).toBeNull();

      // restore
      const restored = await executeCommand(get(byName, 'memory.restore'), { id }, ctx);
      expect(restored.ok && restored.value.embedding).toBeNull();

      // archive
      const archived = await executeCommand(
        get(byName, 'memory.archive'),
        { id, confirm: true },
        ctx,
      );
      expect(archived.ok && archived.value.embedding).toBeNull();
    });

    it('supersede strips embeddings on both previous and current', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      await executeCommand(
        get(byName, 'memory.set_embedding'),
        {
          id: writeRes.value.id,
          model: 'test',
          dimension: 3,
          vector: [0.1, 0.2, 0.3],
        },
        ctx,
      );

      const sup = await executeCommand(
        get(byName, 'memory.supersede'),
        {
          oldId: writeRes.value.id,
          next: { ...writeInput, content: 'updated' },
        },
        ctx,
      );
      expect(sup.ok).toBe(true);
      if (!sup.ok) return;
      expect(sup.value.previous.embedding).toBeNull();
      expect(sup.value.previous.embeddingStatus).toBe('present');
      expect(sup.value.current.embedding).toBeNull();
      // `current` is freshly written; embedder hasn't run yet.
      expect(sup.value.current.embeddingStatus).toBe('pending');
    });
  });

  describe('memory.supersede', () => {
    it('replaces the active head and returns previous + current', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      const sup = await executeCommand(
        get(byName, 'memory.supersede'),
        {
          oldId: writeRes.value.id,
          next: { ...writeInput, content: 'meeting moved to 11am' },
        },
        ctx,
      );
      expect(sup.ok).toBe(true);
      if (!sup.ok) return;
      expect(sup.value.previous.status).toBe('superseded');
      expect(sup.value.current.status).toBe('active');
      expect(sup.value.current.supersedes).toBe(writeRes.value.id);
    });

    it('returns CONFLICT when the head is no longer active', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      // First supersede succeeds; second on the same old id collides.
      await executeCommand(
        get(byName, 'memory.supersede'),
        { oldId: writeRes.value.id, next: { ...writeInput, content: 'v2' } },
        ctx,
      );
      const second = await executeCommand(
        get(byName, 'memory.supersede'),
        { oldId: writeRes.value.id, next: { ...writeInput, content: 'v3' } },
        ctx,
      );
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('CONFLICT');
    });

    it('returns NOT_FOUND when the old id does not exist', async () => {
      const { byName } = await fixture();
      const ghost = `M0${'0'.repeat(23)}X` as unknown as MemoryId;
      const result = await executeCommand(
        get(byName, 'memory.supersede'),
        { oldId: ghost, next: writeInput },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('memory.confirm / update / forget / restore / archive', () => {
    it('runs the full lifecycle through the command surface', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const id = writeRes.value.id;

      const confirmed = await executeCommand(get(byName, 'memory.confirm'), { id }, ctx);
      expect(confirmed.ok).toBe(true);

      const updated = await executeCommand(
        get(byName, 'memory.update'),
        { id, patch: { pinned: true } },
        ctx,
      );
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.pinned).toBe(true);

      const forgotten = await executeCommand(
        get(byName, 'memory.forget'),
        { id, reason: 'no longer relevant', confirm: true },
        ctx,
      );
      expect(forgotten.ok).toBe(true);
      if (!forgotten.ok) return;
      expect(forgotten.value.status).toBe('forgotten');

      const restored = await executeCommand(get(byName, 'memory.restore'), { id }, ctx);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.value.status).toBe('active');

      const archived = await executeCommand(
        get(byName, 'memory.archive'),
        { id, confirm: true },
        ctx,
      );
      expect(archived.ok).toBe(true);
      if (!archived.ok) return;
      expect(archived.value.status).toBe('archived');

      // archive on already-archived is a no-op (idempotent).
      const archivedAgain = await executeCommand(
        get(byName, 'memory.archive'),
        { id, confirm: true },
        ctx,
      );
      expect(archivedAgain.ok).toBe(true);
      if (!archivedAgain.ok) return;
      expect(archivedAgain.value.status).toBe('archived');

      // memory.restore reverses archive too — it is the
      // single inverse for both `forgotten` and `archived`.
      const unarchived = await executeCommand(get(byName, 'memory.restore'), { id }, ctx);
      expect(unarchived.ok).toBe(true);
      if (!unarchived.ok) return;
      expect(unarchived.value.status).toBe('active');
    });

    it('returns INVALID_INPUT when update patch is empty', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      const result = await executeCommand(
        get(byName, 'memory.update'),
        { id: writeRes.value.id, patch: {} },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    // The persona-3 audit (AI assistant calling Memento over MCP)
    // found that `update_memory` rejected `patch.content` with the
    // generic `Unrecognized key(s) in object` Zod error — no hint
    // pointing at supersede. AGENTS.md rule 13 promises that hint;
    // these tests pin its delivery for the three most common
    // mistake keys (content, scope, storedConfidence).
    it('rejects update of content with a hint pointing at memory.supersede', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      const result = await executeCommand(
        get(byName, 'memory.update'),
        { id: writeRes.value.id, patch: { content: 'should be rejected with a hint' } },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/cannot update `content`/);
      expect(result.error.message).toMatch(/memory\.supersede/);
      // Persona-3 follow-up: when a forbidden key is the only key in
      // the patch, the redirect message above is enough — adding the
      // generic "patch must change at least one field" on top is
      // noise. The superRefine short-circuits in that case so the
      // response stays a single actionable line.
      expect(result.error.message).not.toMatch(/at least one field/);
    });

    it('rejects update of scope with a hint pointing at memory.supersede', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      const result = await executeCommand(
        get(byName, 'memory.update'),
        { id: writeRes.value.id, patch: { scope: { type: 'global' } } },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/scope is immutable|cannot update `scope`/);
      expect(result.error.message).toMatch(/memory\.supersede/);
    });

    it('rejects update of storedConfidence with a hint pointing at memory.confirm', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      const result = await executeCommand(
        get(byName, 'memory.update'),
        { id: writeRes.value.id, patch: { storedConfidence: 0.5 } },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/memory\.confirm/);
    });

    it('returns CONFLICT when confirming a forgotten memory', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const id = writeRes.value.id;
      await executeCommand(get(byName, 'memory.forget'), { id, reason: null, confirm: true }, ctx);
      const result = await executeCommand(get(byName, 'memory.confirm'), { id }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONFLICT');
    });

    it('returns NOT_FOUND when forgetting an unknown id', async () => {
      const { byName } = await fixture();
      const ghost = `M0${'0'.repeat(23)}Y` as unknown as MemoryId;
      const result = await executeCommand(
        get(byName, 'memory.forget'),
        { id: ghost, reason: null, confirm: true },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns CONFLICT when restoring a memory that is not forgotten', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      const result = await executeCommand(
        get(byName, 'memory.restore'),
        { id: writeRes.value.id },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONFLICT');
    });
  });

  describe('memory.confirm_many', () => {
    it('confirms multiple active memories in a single call', async () => {
      const { byName } = await fixture();
      const r1 = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!r1.ok) throw new Error('seed 1 failed');
      const r2 = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: 'second memory' },
        ctx,
      );
      if (!r2.ok) throw new Error('seed 2 failed');

      const result = await executeCommand(
        get(byName, 'memory.confirm_many'),
        { ids: [r1.value.id, r2.value.id] },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.confirmed).toBe(2);
      expect(result.value.failed).toEqual([]);
    });

    it('reports per-id failures without blocking others', async () => {
      const { byName } = await fixture();
      const r1 = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!r1.ok) throw new Error('seed failed');

      // forget r1 so confirming it will fail
      await executeCommand(
        get(byName, 'memory.forget'),
        { id: r1.value.id, reason: null, confirm: true },
        ctx,
      );

      const r2 = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: 'still active' },
        ctx,
      );
      if (!r2.ok) throw new Error('seed 2 failed');

      const result = await executeCommand(
        get(byName, 'memory.confirm_many'),
        { ids: [r1.value.id, r2.value.id] },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.confirmed).toBe(1);
      expect(result.value.failed).toHaveLength(1);
      expect(result.value.failed[0].id).toBe(r1.value.id);
    });

    it('returns INVALID_INPUT for empty ids array', async () => {
      const { byName } = await fixture();
      const result = await executeCommand(get(byName, 'memory.confirm_many'), { ids: [] }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('memory.set_embedding', () => {
    it('attaches an embedding to an active memory', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      const result = await executeCommand(
        get(byName, 'memory.set_embedding'),
        {
          id: writeRes.value.id,
          model: 'test-embedder',
          dimension: 3,
          vector: [0.1, 0.2, 0.3],
        },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Per the lean-response design (persona-3 pass), single-memory
      // command outputs strip the embedding vector — the operator
      // already supplied it, so echoing 768 floats back is just
      // payload bloat. Confirm the wire-level signal instead.
      expect(result.value.embedding).toBeNull();
      expect(result.value.embeddingStatus).toBe('present');
      // Round-trip through `memory.read` with `includeEmbedding: true`
      // proves the vector actually persisted; this is the documented
      // opt-in path for callers that want the raw vector back.
      const readRes = await executeCommand(
        get(byName, 'memory.read'),
        { id: writeRes.value.id, includeEmbedding: true },
        ctx,
      );
      expect(readRes.ok).toBe(true);
      if (!readRes.ok) return;
      expect(readRes.value?.embedding?.dimension).toBe(3);
    });

    it('returns INVALID_INPUT on dimension/vector mismatch', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');

      // Caller-side input passes the command schema (vector is a
      // valid number array), but the repo's `EmbeddingSchema.parse`
      // catches the mismatch with `vector.length !== dimension`.
      const result = await executeCommand(
        get(byName, 'memory.set_embedding'),
        {
          id: writeRes.value.id,
          model: 'test-embedder',
          dimension: 5,
          vector: [0.1, 0.2, 0.3],
        },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('afterWrite hook', () => {
    // The hook contract is documented on `MemoryCommandHooks`:
    // fired after `memory.write` and `memory.supersede` produce
    // a fresh active memory; never fired for read-only,
    // taxonomy-only, or lifecycle-only commands; failures are
    // swallowed; the Result is built before the hook runs.

    async function withHook(): Promise<{
      byName: Map<string, AnyCommand>;
      calls: Array<{ memory: Memory; actor: ActorRef }>;
    }> {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const calls: Array<{ memory: Memory; actor: ActorRef }> = [];
      const commands = createMemoryCommands(repo, {
        afterWrite: (memory, hookCtx) => {
          calls.push({ memory, actor: hookCtx.actor });
        },
      });
      return { byName: new Map(commands.map((c) => [c.name, c])), calls };
    }

    it('fires after memory.write with the freshly-active memory', async () => {
      const { byName, calls } = await withHook();
      const result = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(calls).toHaveLength(1);
      expect(calls[0]?.memory.id).toBe(result.value.id);
      expect(calls[0]?.actor).toEqual(ctx.actor);
    });

    it('fires after memory.supersede with `current`, not `previous`', async () => {
      const { byName, calls } = await withHook();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      expect(writeRes.ok).toBe(true);
      if (!writeRes.ok) return;
      calls.length = 0;
      const supersedeRes = await executeCommand(
        get(byName, 'memory.supersede'),
        {
          oldId: writeRes.value.id,
          next: { ...writeInput, content: 'the meeting starts at 11am' },
        },
        ctx,
      );
      expect(supersedeRes.ok).toBe(true);
      if (!supersedeRes.ok) return;
      expect(calls).toHaveLength(1);
      expect(calls[0]?.memory.id).toBe(supersedeRes.value.current.id);
      expect(calls[0]?.memory.id).not.toBe(supersedeRes.value.previous.id);
      expect(calls[0]?.actor).toEqual(ctx.actor);
    });

    it('does not fire for taxonomy-only / lifecycle-only / read-only operations', async () => {
      const { byName, calls } = await withHook();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      expect(writeRes.ok).toBe(true);
      if (!writeRes.ok) return;
      const id: MemoryId = writeRes.value.id;
      calls.length = 0;

      await executeCommand(get(byName, 'memory.read'), { id }, ctx);
      await executeCommand(get(byName, 'memory.list'), {}, ctx);
      await executeCommand(get(byName, 'memory.confirm'), { id }, ctx);
      await executeCommand(get(byName, 'memory.update'), { id, patch: { pinned: true } }, ctx);
      await executeCommand(get(byName, 'memory.forget'), { id, reason: null, confirm: true }, ctx);
      await executeCommand(get(byName, 'memory.restore'), { id }, ctx);
      await executeCommand(get(byName, 'memory.archive'), { id, confirm: true }, ctx);

      expect(calls).toHaveLength(0);
    });

    it('does not fire when the write fails', async () => {
      const { byName, calls } = await withHook();
      // Empty content is rejected by the input schema → handler
      // never runs and the hook must not fire.
      const result = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: '' },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('swallows synchronous hook throws so the write Result is preserved', async () => {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const commands = createMemoryCommands(repo, {
        afterWrite: () => {
          throw new Error('hook exploded');
        },
      });
      const byName = new Map(commands.map((c) => [c.name, c]));

      const result = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      expect(result.ok).toBe(true);
    });
  });

  describe('memory.events', () => {
    async function eventsFixture(): Promise<{
      repo: MemoryRepository;
      byName: Map<string, AnyCommand>;
    }> {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const eventRepository = createEventRepository(handle.db);
      const commands = createMemoryCommands(repo, undefined, {
        eventRepository,
      });
      const byName = new Map(commands.map((c) => [c.name, c]));
      return { repo, byName };
    }

    it('is omitted when no eventRepository dep is supplied', async () => {
      const { byName } = await fixture();
      expect(byName.has('memory.events')).toBe(false);
    });

    it('returns the audit log for one memory in commit order when id is given', async () => {
      const { byName } = await eventsFixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const id = writeRes.value.id;
      const confirmRes = await executeCommand(get(byName, 'memory.confirm'), { id }, ctx);
      if (!confirmRes.ok) throw new Error('confirm failed');

      const result = await executeCommand(get(byName, 'memory.events'), { id }, ctx);
      if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
      const events = result.value as MemoryEvent[];
      expect(events.map((e) => e.type)).toEqual(['created', 'confirmed']);
      expect(events.every((e) => e.memoryId === id)).toBe(true);
    });

    it('returns the cross-memory tail newest-first when id is omitted', async () => {
      const { byName } = await eventsFixture();
      const a = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      const b = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: 'second memory' },
        ctx,
      );
      if (!a.ok || !b.ok) throw new Error('seed failed');

      const result = await executeCommand(get(byName, 'memory.events'), {}, ctx);
      if (!result.ok) throw new Error('expected ok');
      // Newest first: b's `created` precedes a's `created`.
      expect(result.value[0]?.memoryId).toBe(b.value.id);
      expect(result.value[1]?.memoryId).toBe(a.value.id);
    });

    it('filters by event type', async () => {
      const { byName } = await eventsFixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const id = writeRes.value.id;
      await executeCommand(get(byName, 'memory.confirm'), { id }, ctx);
      await executeCommand(get(byName, 'memory.update'), { id, patch: { pinned: true } }, ctx);

      const result = await executeCommand(
        get(byName, 'memory.events'),
        { id, types: ['confirmed', 'updated'] },
        ctx,
      );
      if (!result.ok) throw new Error('expected ok');
      const events = result.value as MemoryEvent[];
      expect(events.map((e) => e.type).sort()).toEqual(['confirmed', 'updated']);
    });

    it('rejects non-positive limit at the input boundary', async () => {
      const { byName } = await eventsFixture();
      const result = await executeCommand(get(byName, 'memory.events'), { limit: 0 }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_INPUT');
      }
    });

    it('filters by since / until at the command boundary', async () => {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      let i = 0;
      const clocks = [
        '2025-01-01T00:00:00.000Z',
        '2025-06-01T00:00:00.000Z',
        '2025-12-01T00:00:00.000Z',
      ];
      const repo = createMemoryRepository(handle.db, {
        clock: () => clocks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const eventRepository = createEventRepository(handle.db);
      const commands = createMemoryCommands(repo, undefined, { eventRepository });
      const byName = new Map(commands.map((c) => [c.name, c]));

      await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      await executeCommand(get(byName, 'memory.write'), { ...writeInput, content: 'mid' }, ctx);
      await executeCommand(get(byName, 'memory.write'), { ...writeInput, content: 'late' }, ctx);

      const halfOpen = await executeCommand(
        get(byName, 'memory.events'),
        {
          since: '2025-06-01T00:00:00.000Z',
          until: '2025-12-01T00:00:00.000Z',
        },
        ctx,
      );
      if (!halfOpen.ok) throw new Error('expected ok');
      expect(halfOpen.value).toHaveLength(1);
      expect(String(halfOpen.value[0]?.at)).toBe('2025-06-01T00:00:00.000Z');
    });
  });

  // Confirm-gate (ADR-0012). `memory.forget` and
  // `memory.archive` are destructive; the schema must require
  // `confirm: z.literal(true)`. `memory.supersede` is not
  // gated (constructive — see ADR-0012).
  describe('confirm gate (ADR-0012)', () => {
    it('memory.forget rejects when confirm is missing', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const result = await executeCommand(
        get(byName, 'memory.forget'),
        { id: writeRes.value.id, reason: null },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('memory.forget rejects when confirm is false', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const result = await executeCommand(
        get(byName, 'memory.forget'),
        { id: writeRes.value.id, reason: null, confirm: false },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('memory.archive rejects when confirm is missing', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const result = await executeCommand(
        get(byName, 'memory.archive'),
        { id: writeRes.value.id },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('memory.archive rejects when confirm is false', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const result = await executeCommand(
        get(byName, 'memory.archive'),
        { id: writeRes.value.id, confirm: false },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('memory.supersede is NOT gated (constructive)', async () => {
      const { byName } = await fixture();
      const writeRes = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!writeRes.ok) throw new Error('seed failed');
      const result = await executeCommand(
        get(byName, 'memory.supersede'),
        {
          oldId: writeRes.value.id,
          next: { ...writeInput, content: 'replacement content' },
        },
        ctx,
      );
      expect(result.ok).toBe(true);
    });
  });

  // clientToken idempotency (ADR-0012 §2). A second `memory.write`
  // with the same `(scope, clientToken)` while the first memory is
  // still active must return the existing memory id without
  // appending a `created` audit event. Across scopes the same
  // token is always allowed; once the memory is forgotten the
  // token is freed for reuse in the same scope.
  describe('clientToken idempotency (ADR-0012)', () => {
    async function tokenFixture(): Promise<{
      byName: Map<string, AnyCommand>;
    }> {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const eventRepository = createEventRepository(handle.db);
      const commands = createMemoryCommands(repo, undefined, { eventRepository });
      return { byName: new Map(commands.map((c) => [c.name, c])) };
    }

    it('same scope + same token returns the same id with one audit row', async () => {
      const { byName } = await tokenFixture();
      const first = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, clientToken: 'req-1' },
        ctx,
      );
      if (!first.ok) throw new Error('first write failed');
      const second = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, clientToken: 'req-1' },
        ctx,
      );
      if (!second.ok) throw new Error('second write failed');
      expect(second.value.id).toBe(first.value.id);

      const events = await executeCommand(
        get(byName, 'memory.events'),
        { id: first.value.id },
        ctx,
      );
      if (!events.ok) throw new Error('events failed');
      const created = (events.value as MemoryEvent[]).filter((e) => e.type === 'created');
      expect(created).toHaveLength(1);
    });

    it('different scopes accept the same token independently', async () => {
      const { byName } = await tokenFixture();
      const inGlobal = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, scope: { type: 'global' as const }, clientToken: 'shared' },
        ctx,
      );
      const inWorkspace = await executeCommand(
        get(byName, 'memory.write'),
        {
          ...writeInput,
          scope: { type: 'workspace' as const, path: '/tmp/ws' },
          clientToken: 'shared',
        },
        ctx,
      );
      if (!inGlobal.ok || !inWorkspace.ok) throw new Error('write failed');
      expect(inWorkspace.value.id).not.toBe(inGlobal.value.id);
    });

    it('forgetting a memory frees its token for reuse in the same scope', async () => {
      const { byName } = await tokenFixture();
      const first = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, clientToken: 'reuse-me' },
        ctx,
      );
      if (!first.ok) throw new Error('first write failed');
      const forgot = await executeCommand(
        get(byName, 'memory.forget'),
        { id: first.value.id, reason: null, confirm: true },
        ctx,
      );
      if (!forgot.ok) throw new Error('forget failed');
      const second = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, clientToken: 'reuse-me' },
        ctx,
      );
      if (!second.ok) throw new Error('second write failed');
      expect(second.value.id).not.toBe(first.value.id);
      expect(second.value.status).toBe('active');
    });

    it('omitted clientToken never collides with another omitted token', async () => {
      const { byName } = await tokenFixture();
      const a = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      const b = await executeCommand(get(byName, 'memory.write'), writeInput, ctx);
      if (!a.ok || !b.ok) throw new Error('write failed');
      expect(b.value.id).not.toBe(a.value.id);
    });

    it('rejects empty clientToken at the input boundary', async () => {
      const { byName } = await tokenFixture();
      const result = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, clientToken: '' },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('rejects clientToken longer than 128 chars', async () => {
      const { byName } = await tokenFixture();
      const result = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, clientToken: 'x'.repeat(129) },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });
  });

  // ADR-0012 §3: sensitive flag + redacted view. Memories
  // written with `sensitive: true` are stored unmodified; the
  // redaction is purely an output-time projection applied by
  // `memory.list` (and `memory.search`) when
  // `privacy.redactSensitiveSnippets` is on. `memory.read`
  // always returns the full content so downstream consumers
  // that already have an `id` can still inspect it.
  describe('sensitive flag + redaction (ADR-0012 §3)', () => {
    async function privacyFixture(
      redact: boolean | undefined,
    ): Promise<{ byName: Map<string, AnyCommand> }> {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const deps =
        redact === undefined
          ? {}
          : {
              configStore: createConfigStore({
                'privacy.redactSensitiveSnippets': redact,
              }),
            };
      const commands = createMemoryCommands(repo, undefined, deps);
      return { byName: new Map(commands.map((c) => [c.name, c])) };
    }

    it('write persists the sensitive flag and read returns full content', async () => {
      const { byName } = await privacyFixture(true);
      const written = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, sensitive: true, content: 'top secret' },
        ctx,
      );
      if (!written.ok) throw new Error('write failed');
      expect((written.value as Memory).sensitive).toBe(true);

      // `memory.read` is the escape hatch: callers that already
      // hold an id always get full content, regardless of the
      // privacy flag.
      const read = await executeCommand(get(byName, 'memory.read'), { id: written.value.id }, ctx);
      if (!read.ok) throw new Error('read failed');
      expect((read.value as Memory).content).toBe('top secret');
      expect((read.value as Memory).sensitive).toBe(true);
    });

    it('list redacts sensitive rows when the config flag is on', async () => {
      const { byName } = await privacyFixture(true);
      const a = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, sensitive: true, content: 'top secret' },
        ctx,
      );
      const b = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: 'public note' },
        ctx,
      );
      if (!a.ok || !b.ok) throw new Error('writes failed');

      const list = await executeCommand(get(byName, 'memory.list'), {}, ctx);
      if (!list.ok) throw new Error('list failed');
      const views = list.value as MemoryView[];
      const byId = new Map(views.map((v) => [v.id, v]));
      const sensitiveView = byId.get(a.value.id);
      const publicView = byId.get(b.value.id);
      if (sensitiveView === undefined || publicView === undefined) {
        throw new Error('expected both rows in list output');
      }
      expect(sensitiveView.redacted).toBe(true);
      expect(sensitiveView.content).toBeNull();
      expect(publicView.redacted).toBe(false);
      expect(publicView.content).toBe('public note');
    });

    it('list returns full content when the config flag is off', async () => {
      const { byName } = await privacyFixture(false);
      const written = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, sensitive: true, content: 'top secret' },
        ctx,
      );
      if (!written.ok) throw new Error('write failed');

      const list = await executeCommand(get(byName, 'memory.list'), {}, ctx);
      if (!list.ok) throw new Error('list failed');
      const view = (list.value as MemoryView[])[0];
      if (view === undefined) throw new Error('expected a row');
      expect(view.redacted).toBe(false);
      expect(view.content).toBe('top secret');
    });

    it('list returns full content when no configStore is wired', async () => {
      // Hosts that don't run the config subsystem must stay
      // backwards-compatible: omitting `configStore` means no
      // redaction happens, even for sensitive rows.
      const { byName } = await privacyFixture(undefined);
      const written = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, sensitive: true, content: 'top secret' },
        ctx,
      );
      if (!written.ok) throw new Error('write failed');

      const list = await executeCommand(get(byName, 'memory.list'), {}, ctx);
      if (!list.ok) throw new Error('list failed');
      const view = (list.value as MemoryView[])[0];
      if (view === undefined) throw new Error('expected a row');
      expect(view.redacted).toBe(false);
      expect(view.content).toBe('top secret');
    });

    it('update flips the sensitive flag on its own', async () => {
      const { byName } = await privacyFixture(true);
      const written = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: 'public note' },
        ctx,
      );
      if (!written.ok) throw new Error('write failed');
      expect((written.value as Memory).sensitive).toBe(false);

      const updated = await executeCommand(
        get(byName, 'memory.update'),
        { id: written.value.id, patch: { sensitive: true } },
        ctx,
      );
      if (!updated.ok) throw new Error('update failed');
      expect((updated.value as Memory).sensitive).toBe(true);

      // After flipping on, list now redacts the row.
      const list = await executeCommand(get(byName, 'memory.list'), {}, ctx);
      if (!list.ok) throw new Error('list failed');
      const view = (list.value as MemoryView[])[0];
      if (view === undefined) throw new Error('expected a row');
      expect(view.redacted).toBe(true);
      expect(view.content).toBeNull();
    });
  });

  // ADR-0012 §4: batch writes via `memory.write_many`. The
  // batch is one transaction — partial failure rolls back the
  // whole call. Per-item `clientToken` idempotency carries
  // through, mixed with fresh inserts in the same call. The
  // batch ceiling is honoured against the wired config store.
  describe('memory.write_many (ADR-0012 §4)', () => {
    async function batchFixture(
      limit: number | undefined,
    ): Promise<{ byName: Map<string, AnyCommand>; repo: MemoryRepository }> {
      const handle = openDatabase({ path: ':memory:' });
      handles.push(handle);
      await migrateToLatest(handle.db, MIGRATIONS);
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const eventRepository = createEventRepository(handle.db);
      const deps =
        limit === undefined
          ? { eventRepository }
          : {
              eventRepository,
              configStore: createConfigStore({ 'safety.batchWriteLimit': limit }),
            };
      const commands = createMemoryCommands(repo, undefined, deps);
      return { byName: new Map(commands.map((c) => [c.name, c])), repo };
    }

    it('writes every item and returns ids in input order', async () => {
      const { byName } = await batchFixture(undefined);
      const result = await executeCommand(
        get(byName, 'memory.write_many'),
        {
          items: [
            { ...writeInput, content: 'one' },
            { ...writeInput, content: 'two' },
            { ...writeInput, content: 'three' },
          ],
        },
        ctx,
      );
      if (!result.ok) throw new Error('write_many failed');
      expect((result.value as { ids: MemoryId[] }).ids).toHaveLength(3);
      expect((result.value as { idempotentCount: number }).idempotentCount).toBe(0);

      // Each id must resolve to a row whose content is the
      // corresponding input. This pins both order and content.
      const ids = (result.value as { ids: MemoryId[] }).ids;
      const expectedContents = ['one', 'two', 'three'];
      for (let i = 0; i < ids.length; i += 1) {
        const read = await executeCommand(get(byName, 'memory.read'), { id: ids[i] }, ctx);
        if (!read.ok) throw new Error('read failed');
        expect((read.value as Memory).content).toBe(expectedContents[i]);
      }
    });

    it('honours per-item clientToken idempotency mixed with fresh inserts', async () => {
      const { byName } = await batchFixture(undefined);
      const first = await executeCommand(
        get(byName, 'memory.write'),
        { ...writeInput, content: 'pre-existing', clientToken: 'tok-1' },
        ctx,
      );
      if (!first.ok) throw new Error('seed write failed');

      const result = await executeCommand(
        get(byName, 'memory.write_many'),
        {
          items: [
            { ...writeInput, content: 'fresh-a' },
            { ...writeInput, content: 'duplicate', clientToken: 'tok-1' },
            { ...writeInput, content: 'fresh-b' },
          ],
        },
        ctx,
      );
      if (!result.ok) throw new Error('write_many failed');
      const value = result.value as { ids: MemoryId[]; idempotentCount: number };
      expect(value.idempotentCount).toBe(1);
      expect(value.ids[1]).toBe(first.value.id);
      expect(value.ids[0]).not.toBe(first.value.id);
      expect(value.ids[2]).not.toBe(first.value.id);
    });

    it('rejects an empty batch at the input boundary', async () => {
      const { byName } = await batchFixture(undefined);
      const result = await executeCommand(get(byName, 'memory.write_many'), { items: [] }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('rejects batches larger than safety.batchWriteLimit', async () => {
      const { byName } = await batchFixture(2);
      const result = await executeCommand(
        get(byName, 'memory.write_many'),
        {
          items: [
            { ...writeInput, content: 'one' },
            { ...writeInput, content: 'two' },
            { ...writeInput, content: 'three' },
          ],
        },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toContain('safety.batchWriteLimit');
    });

    it('rejects on input-schema failure without writing any item', async () => {
      // `storedConfidence: 1.5` fails the wire schema
      // (`z.number().min(0).max(1)`) before the handler runs.
      // The contract is that nothing is committed when *any*
      // item is rejected — verify by checking the table is
      // empty after the call returns INVALID_INPUT.
      const { byName, repo } = await batchFixture(undefined);
      const result = await executeCommand(
        get(byName, 'memory.write_many'),
        {
          items: [
            { ...writeInput, content: 'first' },
            { ...writeInput, content: 'bad', storedConfidence: 1.5 },
            { ...writeInput, content: 'third' },
          ],
        },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_INPUT');

      const all = await repo.list({});
      expect(all).toHaveLength(0);
    });
  });
});
