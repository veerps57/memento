// Tests for `runConflictHook`.
//
// The hook itself is a thin scheduling layer over
// `detectConflicts` — full detection semantics (per-kind
// policies, candidate selection, supersede handling) are
// covered by `detector.test.ts`. This file pins only the four
// scheduling behaviours the hook adds:
//
//   1. `enabled: false` short-circuits to `disabled` and never
//      touches the deps.
//   2. A successful run returns `completed` with the detector's
//      `scanned` / `opened` plus an `elapsedMs` field.
//   3. A run that exceeds `timeoutMs` returns `timeout` and
//      does not throw (the in-flight detector promise is
//      abandoned per ADR-0005's recovery contract).
//   4. A throwing detector is captured as `error`, not
//      rethrown.
//
// Plus one structural test: `scopeStrategy: 'effective'` widens
// the scopes the detector receives.

import type { ActorRef, Memory, Scope } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { runConflictHook } from '../../src/conflict/hook.js';
import { createConflictRepository } from '../../src/conflict/repository.js';
import {
  type MemoryWriteInput,
  createMemoryRepository,
} from '../../src/repository/memory-repository.js';
import { type ActiveScopes, effectiveScopes } from '../../src/scope/resolver.js';
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

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    return `${prefix}${String(i).padStart(24, '0')}`;
  };
}

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
  return { memoryRepo, conflictRepo };
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

// A hand-built `Memory` we can hand the hook in tests where we
// don't need a full DB. Only `id`, `scope`, and `kind.type` are
// read by the detector before `list` is called; the rest are
// filler that lets the value match `Memory`'s structural shape.
const fakeMemory: Memory = {
  id: `M0${'1'.padStart(24, '0')}` as never,
  createdAt: '2025-01-01T00:00:00.000Z' as never,
  schemaVersion: 1,
  scope: { type: 'global' },
  owner: { type: 'local', id: 'tester' },
  kind: { type: 'preference' },
  tags: [],
  pinned: false,
  content: 'tabs: yes',
  summary: null,
  status: 'active',
  storedConfidence: 1,
  lastConfirmedAt: '2025-01-01T00:00:00.000Z' as never,
  supersedes: null,
  supersededBy: null,
  embedding: null,
  sensitive: false,
};

describe('runConflictHook', () => {
  it('short-circuits to "disabled" when enabled is false and never queries the deps', async () => {
    let listCalls = 0;
    let openCalls = 0;
    const memoryRepository = {
      list: async () => {
        listCalls += 1;
        return [];
      },
    };
    const conflictRepository = {
      open: async () => {
        openCalls += 1;
        return null as never;
      },
    };

    const outcome = await runConflictHook(
      fakeMemory,
      {
        memoryRepository: memoryRepository as never,
        conflictRepository: conflictRepository as never,
      },
      { enabled: false, timeoutMs: 2_000, scopeStrategy: 'same' },
      { actor },
    );

    expect(outcome).toEqual({ status: 'disabled' });
    expect(listCalls).toBe(0);
    expect(openCalls).toBe(0);
  });

  it('returns "completed" with the detector outcome plus elapsedMs on success', async () => {
    const { memoryRepo, conflictRepo } = await fixture();
    const first = await memoryRepo.write(baseInput, { actor });
    const second = await memoryRepo.write({ ...baseInput, content: 'tabs: no' }, { actor });

    const outcome = await runConflictHook(
      second,
      { memoryRepository: memoryRepo, conflictRepository: conflictRepo },
      { enabled: true, timeoutMs: 2_000, scopeStrategy: 'same' },
      { actor },
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.scanned).toBe(2);
    expect(outcome.opened).toHaveLength(1);
    const opened = outcome.opened[0];
    if (opened === undefined) throw new Error('expected one conflict');
    expect(opened.newMemoryId).toBe(second.id);
    expect(opened.conflictingMemoryId).toBe(first.id);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns "timeout" when the detector does not finish within the budget', async () => {
    // Detector is asked to list candidates; we hand back a
    // promise that never resolves so the only way out is the
    // timeout path. A controllable `setTimeoutImpl` keeps the
    // test deterministic — no real wall-clock waiting.
    const memoryRepository = {
      list: () => new Promise<Memory[]>(() => {}),
    };
    const conflictRepository = {
      open: async () => null as never,
    };

    const outcome = await runConflictHook(
      fakeMemory,
      {
        memoryRepository: memoryRepository as never,
        conflictRepository: conflictRepository as never,
      },
      { enabled: true, timeoutMs: 5_000, scopeStrategy: 'same' },
      {
        actor,
        // Fire the timer immediately, ignoring the requested ms.
        setTimeoutImpl: (cb) => {
          queueMicrotask(cb);
          return 0;
        },
        clearTimeoutImpl: () => {},
      },
    );

    expect(outcome.status).toBe('timeout');
    if (outcome.status !== 'timeout') return;
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns "error" with the thrown value when the detector rejects', async () => {
    const boom = new Error('list exploded');
    const memoryRepository = {
      list: async () => {
        throw boom;
      },
    };
    const conflictRepository = {
      open: async () => null as never,
    };

    const outcome = await runConflictHook(
      fakeMemory,
      {
        memoryRepository: memoryRepository as never,
        conflictRepository: conflictRepository as never,
      },
      { enabled: true, timeoutMs: 2_000, scopeStrategy: 'same' },
      { actor },
    );

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error).toBe(boom);
  });

  it('passes effective scopes to the detector when scopeStrategy is "effective"', async () => {
    let observedScope: readonly Scope[] | undefined;
    const memoryRepository = {
      list: async (filter: { scope?: readonly Scope[] }) => {
        observedScope = filter.scope;
        return [] as Memory[];
      },
    };
    const conflictRepository = {
      open: async () => null as never,
    };

    const activeScopes: ActiveScopes = {
      session: null,
      branch: null,
      repo: null,
      workspace: { type: 'workspace', path: '/tmp/eff' as never },
      global: { type: 'global' },
    };

    await runConflictHook(
      fakeMemory,
      {
        memoryRepository: memoryRepository as never,
        conflictRepository: conflictRepository as never,
      },
      { enabled: true, timeoutMs: 2_000, scopeStrategy: 'effective' },
      { actor, activeScopes },
    );

    // The hook must hand the detector exactly the layered set
    // `effectiveScopes` produces — order included, since the
    // detector relays it verbatim into `MemoryRepository.list`.
    expect(observedScope).toEqual(effectiveScopes(activeScopes));
  });

  it('falls back to [memory.scope] when scopeStrategy is "same"', async () => {
    let observedScope: readonly Scope[] | undefined;
    const memoryRepository = {
      list: async (filter: { scope?: readonly Scope[] }) => {
        observedScope = filter.scope;
        return [] as Memory[];
      },
    };
    const conflictRepository = {
      open: async () => null as never,
    };

    await runConflictHook(
      fakeMemory,
      {
        memoryRepository: memoryRepository as never,
        conflictRepository: conflictRepository as never,
      },
      { enabled: true, timeoutMs: 2_000, scopeStrategy: 'same' },
      { actor },
    );

    expect(observedScope).toEqual([fakeMemory.scope]);
  });
});
