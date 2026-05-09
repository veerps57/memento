import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
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

// Deterministic id factories. The schema requires Crockford ULID
// shape (26 chars, [0-9A-HJKMNP-TV-Z]+), so we hand-craft strings
// in that alphabet rather than use `ulid()` which is non-deterministic.
function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    // Pad to 26 chars total; prefix is 2 chars + numeric padded to 24.
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
  tags: ['Hello', 'world', 'hello'], // dedupe + lowercase exercised
  pinned: false,
  content: 'the meeting starts at 10am',
  summary: null,
  storedConfidence: 0.9,
};

describe('createMemoryRepository', () => {
  describe('write', () => {
    it('creates a memory plus a `created` event in one transaction', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });

      const memory = await repo.write(baseInput, { actor });

      expect(memory.id).toBe(`M0${'0'.repeat(23)}1`);
      expect(memory.status).toBe('active');
      expect(memory.createdAt).toBe(fixedClock);
      expect(memory.lastConfirmedAt).toBe(fixedClock);
      expect(memory.supersedes).toBeNull();
      expect(memory.supersededBy).toBeNull();
      expect(memory.embedding).toBeNull();
      // tags normalised + sorted + deduped
      expect(memory.tags).toEqual(['hello', 'world']);

      const events = handle.raw
        .prepare('select id, memory_id, type, payload_json from memory_events')
        .all() as Array<{
        id: string;
        memory_id: string;
        type: string;
        payload_json: string;
      }>;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        memory_id: memory.id,
        type: 'created',
        payload_json: '{}',
      });
    });

    it('rolls back on event-insert failure (atomicity)', async () => {
      const handle = await fixture();
      // Force a primary-key collision on the second insert by
      // returning the same event id every time.
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: () => `E0${'0'.repeat(23)}1`,
      });

      await repo.write(baseInput, { actor });
      await expect(repo.write(baseInput, { actor })).rejects.toThrow();

      // First write left both rows; second write rolled back leaving
      // only the originals.
      const memCount = handle.raw.prepare('select count(*) as n from memories').get() as {
        n: number;
      };
      const evCount = handle.raw.prepare('select count(*) as n from memory_events').get() as {
        n: number;
      };
      expect(memCount.n).toBe(1);
      expect(evCount.n).toBe(1);
    });

    it('rejects invalid storedConfidence at the schema boundary', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await expect(
        repo.write({ ...baseInput, storedConfidence: 1.5 }, { actor }),
      ).rejects.toThrow();
    });
  });

  describe('read', () => {
    it('round-trips a written memory through MemorySchema', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const written = await repo.write(
        {
          ...baseInput,
          kind: { type: 'decision', rationale: 'because' },
          tags: ['ops'],
          summary: 'short',
          storedConfidence: 0.42,
        },
        { actor },
      );
      const read = await repo.read(written.id);
      expect(read).not.toBeNull();
      expect(read).toEqual(written);
    });

    it('returns null for an unknown id', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db);
      const missing = await repo.read('01ARZ3NDEKTSV4RRFFQ69G5FAV' as never);
      expect(missing).toBeNull();
    });
  });

  describe('list', () => {
    it('orders by last_confirmed_at desc then id desc and applies limit', async () => {
      const handle = await fixture();
      let i = 0;
      const repo = createMemoryRepository(handle.db, {
        clock: () => {
          // Three writes one second apart so ordering is deterministic.
          const minute = String(i).padStart(2, '0');
          return `2025-01-01T00:00:${minute}.000Z` as never;
        },
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      for (i = 1; i <= 3; i += 1) {
        await repo.write(baseInput, { actor });
      }
      const rows = await repo.list({ limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.lastConfirmedAt).toBe('2025-01-01T00:00:03.000Z');
      expect(rows[1]?.lastConfirmedAt).toBe('2025-01-01T00:00:02.000Z');
    });

    it('filters by status, kind, and pinned', async () => {
      const handle = await fixture();
      let n = 0;
      const repo = createMemoryRepository(handle.db, {
        clock: () => {
          n += 1;
          return `2025-01-01T00:00:${String(n).padStart(2, '0')}.000Z` as never;
        },
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write(baseInput, { actor });
      await repo.write({ ...baseInput, kind: { type: 'preference' } }, { actor });
      await repo.write({ ...baseInput, pinned: true }, { actor });

      const facts = await repo.list({ kind: 'fact' });
      expect(facts.map((m) => m.kind.type)).toEqual(['fact', 'fact']);

      const pinned = await repo.list({ pinned: true });
      expect(pinned).toHaveLength(1);
      expect(pinned[0]?.pinned).toBe(true);

      const allActive = await repo.list({ status: 'active' });
      expect(allActive).toHaveLength(3);

      const archived = await repo.list({ status: 'archived' });
      expect(archived).toHaveLength(0);
    });

    it('rejects a non-positive limit', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db);
      await expect(repo.list({ limit: 0 })).rejects.toThrow(RangeError);
      await expect(repo.list({ limit: -1 })).rejects.toThrow(RangeError);
      await expect(repo.list({ limit: 1.5 })).rejects.toThrow(RangeError);
    });

    it('filters by a single scope (exact match on scope_type + scope_json)', async () => {
      const handle = await fixture();
      let n = 0;
      const repo = createMemoryRepository(handle.db, {
        clock: () => {
          n += 1;
          return `2025-01-01T00:00:${String(n).padStart(2, '0')}.000Z` as never;
        },
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write(baseInput, { actor });
      await repo.write(
        {
          ...baseInput,
          scope: { type: 'workspace', path: '/tmp/proj' as never },
        },
        { actor },
      );
      await repo.write(
        {
          ...baseInput,
          scope: { type: 'repo', remote: 'github.com/org/proj' as never },
        },
        { actor },
      );

      const globals = await repo.list({ scope: { type: 'global' } });
      expect(globals.map((m) => m.scope.type)).toEqual(['global']);

      const repos = await repo.list({
        scope: { type: 'repo', remote: 'github.com/org/proj' as never },
      });
      expect(repos.map((m) => m.scope.type)).toEqual(['repo']);
    });

    it('filters by a list of scopes (OR over equality, layered-read shape)', async () => {
      const handle = await fixture();
      let n = 0;
      const repo = createMemoryRepository(handle.db, {
        clock: () => {
          n += 1;
          return `2025-01-01T00:00:${String(n).padStart(2, '0')}.000Z` as never;
        },
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write(baseInput, { actor });
      await repo.write(
        {
          ...baseInput,
          scope: { type: 'workspace', path: '/tmp/proj' as never },
        },
        { actor },
      );
      await repo.write(
        {
          ...baseInput,
          scope: { type: 'repo', remote: 'github.com/org/proj' as never },
        },
        { actor },
      );

      const filtered = await repo.list({
        scope: [{ type: 'global' }, { type: 'workspace', path: '/tmp/proj' as never }],
      });
      expect(filtered.map((m) => m.scope.type).sort()).toEqual(['global', 'workspace']);
    });

    it('returns no rows when the scope filter is an empty array', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write(baseInput, { actor });
      const rows = await repo.list({ scope: [] });
      expect(rows).toEqual([]);
    });
  });

  describe('listClientTokensForFilter', () => {
    it('returns clientTokens for memories matching the filter, skipping NULL tokens', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write({ ...baseInput, content: 'one', clientToken: 'pack-aaaa' }, { actor });
      await repo.write({ ...baseInput, content: 'two', clientToken: 'pack-bbbb' }, { actor });
      // No clientToken — should be skipped from the result.
      await repo.write({ ...baseInput, content: 'three' }, { actor });

      const tokens = await repo.listClientTokensForFilter({ status: 'active' });
      expect(tokens.slice().sort()).toEqual(['pack-aaaa', 'pack-bbbb']);
    });

    it('honours tag, scope, and status filters', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write(
        {
          ...baseInput,
          content: 'global-tagged',
          tags: ['pack:foo:1.0.0'],
          clientToken: 'pack-T1',
        },
        { actor },
      );
      await repo.write(
        {
          ...baseInput,
          content: 'global-untagged',
          clientToken: 'pack-T2',
        },
        { actor },
      );
      await repo.write(
        {
          ...baseInput,
          scope: { type: 'workspace', path: '/repo/x' as never },
          tags: ['pack:foo:1.0.0'],
          content: 'workspace-tagged',
          clientToken: 'pack-T3',
        },
        { actor },
      );

      const onlyGlobalAndTagged = await repo.listClientTokensForFilter({
        status: 'active',
        tags: ['pack:foo:1.0.0'],
        scope: { type: 'global' },
      });
      expect(onlyGlobalAndTagged).toEqual(['pack-T1']);
    });

    it('returns an empty array when no memories match', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write({ ...baseInput, clientToken: 'pack-X' }, { actor });
      const tokens = await repo.listClientTokensForFilter({
        status: 'active',
        tags: ['nonexistent'],
      });
      expect(tokens).toEqual([]);
    });
  });

  describe('supersede', () => {
    it('flips the old memory and links both directions atomically', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const original = await repo.write(baseInput, { actor });
      const { previous, current } = await repo.supersede(
        original.id,
        { ...baseInput, content: 'meeting moved to 11am' },
        { actor },
      );

      expect(previous.id).toBe(original.id);
      expect(previous.status).toBe('superseded');
      expect(previous.supersededBy).toBe(current.id);
      expect(previous.supersedes).toBeNull();

      expect(current.status).toBe('active');
      expect(current.supersedes).toBe(original.id);
      expect(current.supersededBy).toBeNull();
      expect(current.content).toBe('meeting moved to 11am');

      const events = handle.raw
        .prepare('select memory_id, type from memory_events order by id')
        .all() as Array<{ memory_id: string; type: string }>;
      expect(events).toEqual([
        { memory_id: original.id, type: 'created' },
        { memory_id: current.id, type: 'created' },
        { memory_id: original.id, type: 'superseded' },
      ]);

      const supersededPayload = handle.raw
        .prepare(
          "select payload_json from memory_events where memory_id = ? and type = 'superseded'",
        )
        .get(original.id) as { payload_json: string };
      expect(JSON.parse(supersededPayload.payload_json)).toEqual({
        replacementId: current.id,
      });
    });

    it('rejects superseding a non-active memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const original = await repo.write(baseInput, { actor });
      await repo.supersede(original.id, baseInput, { actor });

      // Already superseded; second supersede must fail.
      await expect(repo.supersede(original.id, baseInput, { actor })).rejects.toThrow(/not active/);

      // The state of the world is unchanged.
      const memCount = handle.raw.prepare('select count(*) as n from memories').get() as {
        n: number;
      };
      expect(memCount.n).toBe(2);
    });

    it('rejects superseding an unknown id', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db);
      await expect(
        repo.supersede('01ARZ3NDEKTSV4RRFFQ69G5FAV' as never, baseInput, {
          actor,
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('confirm', () => {
    it('bumps last_confirmed_at and emits a `confirmed` event', async () => {
      const handle = await fixture();
      let n = 0;
      const repo = createMemoryRepository(handle.db, {
        clock: () => {
          n += 1;
          return `2025-01-01T00:00:${String(n).padStart(2, '0')}.000Z` as never;
        },
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      const confirmed = await repo.confirm(created.id, { actor });
      expect(confirmed.lastConfirmedAt).toBe('2025-01-01T00:00:02.000Z');
      expect(confirmed.createdAt).toBe(created.createdAt);

      const events = handle.raw
        .prepare('select type from memory_events order by id')
        .all() as Array<{ type: string }>;
      expect(events.map((e) => e.type)).toEqual(['created', 'confirmed']);
    });

    it('rejects confirming a non-active memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      await repo.forget(created.id, null, { actor });
      await expect(repo.confirm(created.id, { actor })).rejects.toThrow(/status=forgotten/);
    });

    it('does not regress last_confirmed_at when the clock skews backwards', async () => {
      const handle = await fixture();
      const ticks = ['2025-06-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'];
      let i = 0;
      const repo = createMemoryRepository(handle.db, {
        clock: () => ticks[i++] as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      // Second tick is *earlier* than the first — simulates an
      // NTP step backwards or a flaky test clock.
      const confirmed = await repo.confirm(created.id, { actor });
      expect(confirmed.lastConfirmedAt).toBe(created.lastConfirmedAt);
    });
  });

  describe('update', () => {
    it('mutates tags / kind / pinned and emits an `updated` event', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      const updated = await repo.update(
        created.id,
        { tags: ['updated', 'TAG'], pinned: true },
        { actor },
      );
      expect(updated.tags).toEqual(['tag', 'updated']);
      expect(updated.pinned).toBe(true);
      expect(updated.kind).toEqual(created.kind);

      const evRow = handle.raw
        .prepare("select payload_json from memory_events where type = 'updated'")
        .get() as { payload_json: string };
      expect(JSON.parse(evRow.payload_json)).toEqual({
        tags: ['tag', 'updated'],
        pinned: true,
      });
    });

    it('rejects an empty patch', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      await expect(repo.update(created.id, {}, { actor })).rejects.toThrow(/at least one field/);
    });

    it('rejects updating a non-active memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      await repo.archive(created.id, { actor });
      await expect(repo.update(created.id, { pinned: true }, { actor })).rejects.toThrow(
        /status=archived/,
      );
    });

    it('rejects cross-type kind changes (snippet → fact loses metadata)', async () => {
      // Silently dropping a snippet's `language` field on a kind
      // change is an audit-history bug. Cross-kind updates must
      // route through `supersede`.
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(
        { ...baseInput, kind: { type: 'snippet', language: 'typescript' } },
        { actor },
      );
      await expect(repo.update(created.id, { kind: { type: 'fact' } }, { actor })).rejects.toThrow(
        /cannot change memory kind/,
      );
    });

    it('rejects cross-type kind changes (decision → preference)', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(
        { ...baseInput, kind: { type: 'decision', rationale: 'team consensus' } },
        { actor },
      );
      await expect(
        repo.update(created.id, { kind: { type: 'preference' } }, { actor }),
      ).rejects.toThrow(/cannot change memory kind/);
    });

    // write-path Unicode
    // canonicalization runs through every memory.update test below.
    // The repo update path doesn't touch content; the normaliser
    // applies on write/supersede only. Coverage for those lives in
    // the dedicated "Unicode hardening" describe below.
    it('allows same-type kind updates (snippet stays snippet, language changes)', async () => {
      // The intent of `update.kind` is to refine kind-specific
      // metadata in place — e.g. switch a snippet from `js` to `ts`.
      // Same-type edits are lossless and stay legal.
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(
        { ...baseInput, kind: { type: 'snippet', language: 'js' } },
        { actor },
      );
      const updated = await repo.update(
        created.id,
        { kind: { type: 'snippet', language: 'typescript' } },
        { actor },
      );
      expect(updated.kind).toEqual({ type: 'snippet', language: 'typescript' });
    });
  });

  describe('forget / restore', () => {
    it('forget then restore returns to active and logs both events', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      const forgotten = await repo.forget(created.id, 'no longer relevant', {
        actor,
      });
      expect(forgotten.status).toBe('forgotten');
      const restored = await repo.restore(created.id, { actor });
      expect(restored.status).toBe('active');

      const events = handle.raw
        .prepare('select type, payload_json from memory_events order by id')
        .all() as Array<{ type: string; payload_json: string }>;
      expect(events.map((e) => e.type)).toEqual(['created', 'forgotten', 'restored']);
      expect(JSON.parse(events[1]?.payload_json ?? '{}')).toEqual({
        reason: 'no longer relevant',
      });
    });

    it('rejects restoring a non-forgotten memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      await expect(repo.restore(created.id, { actor })).rejects.toThrow(/status=active/);
    });

    it('restores an archived memory back to active', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      await repo.archive(created.id, { actor });
      const restored = await repo.restore(created.id, { actor });
      expect(restored.status).toBe('active');

      const types = (
        handle.raw.prepare('select type from memory_events order by id').all() as Array<{
          type: string;
        }>
      ).map((e) => e.type);
      expect(types).toEqual(['created', 'archived', 'restored']);
    });

    it('rejects restoring a superseded memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const original = await repo.write(baseInput, { actor });
      await repo.supersede(original.id, baseInput, { actor });
      await expect(repo.restore(original.id, { actor })).rejects.toThrow(/status=superseded/);
    });
  });

  describe('archive', () => {
    it('flips status from active and logs an `archived` event', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      const archived = await repo.archive(created.id, { actor });
      expect(archived.status).toBe('archived');

      const types = (
        handle.raw.prepare('select type from memory_events order by id').all() as Array<{
          type: string;
        }>
      ).map((e) => e.type);
      expect(types).toEqual(['created', 'archived']);
    });

    it('is idempotent on an already-archived memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      await repo.archive(created.id, { actor });
      const second = await repo.archive(created.id, { actor });
      expect(second.status).toBe('archived');

      const evCount = handle.raw
        .prepare("select count(*) as n from memory_events where type = 'archived'")
        .get() as { n: number };
      expect(evCount.n).toBe(1);
    });

    it('archives a forgotten memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const created = await repo.write(baseInput, { actor });
      await repo.forget(created.id, null, { actor });
      const archived = await repo.archive(created.id, { actor });
      expect(archived.status).toBe('archived');
    });
  });

  describe('scrubber integration', () => {
    const secretRule = {
      id: 'test-secret',
      description: 'fake secret pattern for testing',
      pattern: 'sk-[A-Za-z0-9]{6,}',
      placeholder: '<r:{{rule.id}}>',
      severity: 'high' as const,
    };

    it('write() scrubs content and records the report on the created event', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
        scrubber: { rules: [secretRule] },
      });
      const m = await repo.write(
        { ...baseInput, content: 'leaked sk-ABCDEFGH then nothing' },
        { actor },
      );
      expect(m.content).toBe('leaked <r:test-secret> then nothing');

      const ev = handle.raw
        .prepare("select scrub_report_json from memory_events where type = 'created'")
        .get() as { scrub_report_json: string };
      const report = JSON.parse(ev.scrub_report_json);
      expect(report.rules).toEqual([{ ruleId: 'test-secret', matches: 1, severity: 'high' }]);
      expect(report.byteOffsets).toEqual([[7, 18]]);
    });

    it('write() records an empty (non-null) report when no rule matches', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
        scrubber: { rules: [secretRule] },
      });
      const m = await repo.write({ ...baseInput, content: 'no secrets here' }, { actor });
      expect(m.content).toBe('no secrets here');
      const ev = handle.raw
        .prepare("select scrub_report_json from memory_events where type = 'created'")
        .get() as { scrub_report_json: string };
      expect(JSON.parse(ev.scrub_report_json)).toEqual({
        rules: [],
        byteOffsets: [],
      });
    });

    it('write() with enabled: false is a pass-through (null scrubReport)', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
        scrubber: { rules: [secretRule], enabled: false },
      });
      const m = await repo.write({ ...baseInput, content: 'leaked sk-ABCDEFGH' }, { actor });
      expect(m.content).toBe('leaked sk-ABCDEFGH');
      const ev = handle.raw
        .prepare("select scrub_report_json from memory_events where type = 'created'")
        .get() as { scrub_report_json: string | null };
      expect(ev.scrub_report_json).toBeNull();
    });

    it('write() with no scrubber dep records null scrubReport', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      await repo.write({ ...baseInput, content: 'leaked sk-ABCDEFGH' }, { actor });
      const ev = handle.raw
        .prepare("select scrub_report_json from memory_events where type = 'created'")
        .get() as { scrub_report_json: string | null };
      expect(ev.scrub_report_json).toBeNull();
    });

    it('supersede() scrubs the new content and attaches the report to its created event', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
        scrubber: { rules: [secretRule] },
      });
      const original = await repo.write(baseInput, { actor });
      const { current } = await repo.supersede(
        original.id,
        { ...baseInput, content: 'updated sk-ZZZZZZZZ done' },
        { actor },
      );
      expect(current.content).toBe('updated <r:test-secret> done');

      // Two `created` events total (original + replacement); the
      // replacement carries a non-empty report.
      const events = handle.raw
        .prepare(
          "select memory_id, scrub_report_json from memory_events where type = 'created' order by id",
        )
        .all() as Array<{ memory_id: string; scrub_report_json: string }>;
      expect(events).toHaveLength(2);
      const replacement = events.find((e) => e.memory_id === current.id);
      expect(replacement).toBeDefined();
      const report = JSON.parse(replacement!.scrub_report_json);
      expect(report.rules[0]?.ruleId).toBe('test-secret');
    });

    // Secrets must be redacted regardless of which free-text
    // field they arrive in. Earlier the scrubber operated on
    // `content` only — an LLM auto-generating a summary from
    // raw content trivially round-tripped the secret into the
    // persisted summary, defeating the whole defence.
    it('write() also scrubs the summary and aggregates matches into the report', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
        scrubber: { rules: [secretRule] },
      });
      const m = await repo.write(
        {
          ...baseInput,
          content: 'leaked sk-ABCDEFGH then nothing',
          summary: 'caller paraphrased sk-ZZZZZZZZ here',
        },
        { actor },
      );
      expect(m.content).toContain('<r:test-secret>');
      expect(m.summary).toBe('caller paraphrased <r:test-secret> here');
      expect(m.summary).not.toContain('ZZZZZZZZ');

      const ev = handle.raw
        .prepare("select scrub_report_json from memory_events where type = 'created'")
        .get() as { scrub_report_json: string };
      const report = JSON.parse(ev.scrub_report_json);
      // Aggregated count across content + summary.
      expect(report.rules).toEqual([{ ruleId: 'test-secret', matches: 2, severity: 'high' }]);
    });

    it('write() scrubs the rationale on a decision-kind memory', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
        scrubber: { rules: [secretRule] },
      });
      const m = await repo.write(
        {
          ...baseInput,
          kind: { type: 'decision', rationale: 'rejected because sk-PRIVATEK leaked' },
          content: 'choose option B',
        },
        { actor },
      );
      expect(m.kind.type).toBe('decision');
      if (m.kind.type === 'decision') {
        expect(m.kind.rationale).toBe('rejected because <r:test-secret> leaked');
      }
      const ev = handle.raw
        .prepare("select scrub_report_json from memory_events where type = 'created'")
        .get() as { scrub_report_json: string };
      const report = JSON.parse(ev.scrub_report_json);
      expect(report.rules[0]?.ruleId).toBe('test-secret');
      expect(report.rules[0]?.matches).toBe(1);
    });

    it('supersede() scrubs summary and rationale on the replacement', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
        scrubber: { rules: [secretRule] },
      });
      const original = await repo.write(baseInput, { actor });
      const { current } = await repo.supersede(
        original.id,
        {
          ...baseInput,
          kind: { type: 'decision', rationale: 'pivoted because sk-NEWPRIVK' },
          content: 'pivoted approach',
          summary: 'note about sk-INSUMMARY',
        },
        { actor },
      );
      expect(current.summary).not.toContain('INSUMMARY');
      if (current.kind.type === 'decision') {
        expect(current.kind.rationale).not.toContain('NEWPRIVK');
      }
    });
  });

  // The write path normalises
  // every persisted free-text field: NFC, zero-width strip, control-
  // char strip, bidi-override reject.
  describe('Unicode hardening on write', () => {
    it('NFC-normalises content so NFD input is stored as the canonical NFC form', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      // U+0065 LATIN SMALL LETTER E + U+0301 COMBINING ACUTE ACCENT
      // (NFD). After normalisation we expect the precomposed
      // U+00E9 (NFC) byte-sequence.
      const nfd: string = 'café';
      const nfc: string = 'café';
      // Sanity — the two strings differ pre-normalisation. Annotated as
      // plain `string` (not their literal types) so the compiler does not
      // strength-check the equality and demote the runtime assertion.
      expect(nfd === nfc).toBe(false);
      const m = await repo.write({ ...baseInput, content: nfd }, { actor });
      expect(m.content).toBe(nfc);
    });

    it('strips zero-width characters from content', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const polluted = 'pa​ss‌wo‍rd﻿leak';
      const m = await repo.write({ ...baseInput, content: polluted }, { actor });
      expect(m.content).toBe('passwordleak');
    });

    it('strips non-printable control characters but keeps tab/newline/CR', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      // NUL + a few C0 controls + tab + newline + CR + visible.
      const polluted = 'before\x00\x01\x02\tinner\nnext\rrest';
      const m = await repo.write({ ...baseInput, content: polluted }, { actor });
      expect(m.content).toBe('before\tinner\nnext\rrest');
    });

    it('rejects content containing the U+202E bidi override character', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const polluted = 'normal text ‮ reversed evil';
      await expect(repo.write({ ...baseInput, content: polluted }, { actor })).rejects.toThrow(
        /U\+202E|bidirectional override/,
      );
    });

    it('applies the same canonicalisation to summary and decision rationale', async () => {
      const handle = await fixture();
      const repo = createMemoryRepository(handle.db, {
        clock: () => fixedClock as never,
        memoryIdFactory: counterFactory('M0') as never,
        eventIdFactory: counterFactory('E0'),
      });
      const m = await repo.write(
        {
          ...baseInput,
          kind: { type: 'decision', rationale: 'rationale​zero-width' },
          content: 'café', // NFD café
          summary: 'pa​ss',
        },
        { actor },
      );
      expect(m.content).toBe('café');
      expect(m.summary).toBe('pass');
      if (m.kind.type === 'decision') {
        expect(m.kind.rationale).toBe('rationalezero-width');
      }
    });
  });
});
