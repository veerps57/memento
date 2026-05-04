import type { ActorRef, Timestamp } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfigRepository } from '../../src/config/config-repository.js';
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

const fixedClock = '2025-01-01T00:00:00.000Z' as Timestamp;
const cliActor: ActorRef = { type: 'cli' };
const mcpActor: ActorRef = { type: 'mcp', agent: 'agent-x' };

describe('createConfigRepository', () => {
  describe('set', () => {
    it('persists an event with oldValue=null on first write', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });

      const event = await repo.set(
        { key: 'decay.pinnedFloor', value: 0.7, source: 'cli' },
        { actor: cliActor },
      );

      expect(event.key).toBe('decay.pinnedFloor');
      expect(event.oldValue).toBeNull();
      expect(event.newValue).toBe(0.7);
      expect(event.source).toBe('cli');
      expect(event.actor).toEqual(cliActor);
      expect(event.at).toBe(fixedClock);
    });

    it('captures the prior persisted value as oldValue on subsequent writes', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });

      await repo.set({ key: 'decay.pinnedFloor', value: 0.5, source: 'cli' }, { actor: cliActor });
      const second = await repo.set(
        { key: 'decay.pinnedFloor', value: 0.9, source: 'mcp' },
        { actor: mcpActor },
      );

      expect(second.oldValue).toBe(0.5);
      expect(second.newValue).toBe(0.9);
      expect(second.source).toBe('mcp');
    });

    it('records priorEffectiveValue as oldValue when no prior event exists', async () => {
      // The dashboard / config.set handler passes the engine's
      // effective value (typically the schema default) so the
      // first edit reads `default → newValue` in the audit feed
      // rather than `null → newValue`.
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });

      const event = await repo.set(
        {
          key: 'decay.pinnedFloor',
          value: 0.4,
          source: 'cli',
          priorEffectiveValue: 0.85,
        },
        { actor: cliActor },
      );

      expect(event.oldValue).toBe(0.85);
      expect(event.newValue).toBe(0.4);
    });

    it('priorEffectiveValue is ignored when a prior set event exists', async () => {
      // The latest persisted event is the source of truth for an
      // ongoing audit chain — only the *first* edit substitutes
      // priorEffectiveValue. Otherwise consecutive overrides
      // would lose the link from the prior runtime override.
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });

      await repo.set({ key: 'decay.pinnedFloor', value: 0.6, source: 'cli' }, { actor: cliActor });
      const second = await repo.set(
        {
          key: 'decay.pinnedFloor',
          value: 0.9,
          source: 'cli',
          priorEffectiveValue: 0.0, // would-be default, must not win
        },
        { actor: cliActor },
      );
      expect(second.oldValue).toBe(0.6);
      expect(second.newValue).toBe(0.9);
    });

    it('priorEffectiveValue wins again after an unset reverts the runtime layer', async () => {
      // After unset, the engine's effective value is whichever
      // lower layer (default / file / env) had the key. The
      // next set's audit `oldValue` should reflect that lower
      // layer, not the literal `null` written by the unset event.
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });

      await repo.set({ key: 'decay.pinnedFloor', value: 0.7, source: 'cli' }, { actor: cliActor });
      await repo.unset({ key: 'decay.pinnedFloor', source: 'cli' }, { actor: cliActor });
      const next = await repo.set(
        {
          key: 'decay.pinnedFloor',
          value: 0.3,
          source: 'cli',
          priorEffectiveValue: 0.85, // the schema default, post-unset
        },
        { actor: cliActor },
      );
      expect(next.oldValue).toBe(0.85);
      expect(next.newValue).toBe(0.3);
    });

    it('falls back to oldValue=null when priorEffectiveValue is omitted (legacy callers)', async () => {
      // Existing callers (CLI, MCP, scripts, tests) that don't
      // plumb a config store through still see the original
      // legacy behaviour. Important so the new param is purely
      // additive.
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });

      const event = await repo.set(
        { key: 'decay.pinnedFloor', value: 0.4, source: 'cli' },
        { actor: cliActor },
      );
      expect(event.oldValue).toBeNull();
    });
  });

  describe('unset', () => {
    it('writes an event with newValue=null and prior value preserved as oldValue', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });

      await repo.set({ key: 'decay.pinnedFloor', value: 0.42, source: 'cli' }, { actor: cliActor });
      const unsetEvent = await repo.unset(
        { key: 'decay.pinnedFloor', source: 'cli' },
        { actor: cliActor },
      );

      expect(unsetEvent.oldValue).toBe(0.42);
      expect(unsetEvent.newValue).toBeNull();
    });

    it('records oldValue=null when unsetting a key that was never set', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });
      const event = await repo.unset(
        { key: 'decay.pinnedFloor', source: 'cli' },
        { actor: cliActor },
      );
      expect(event.oldValue).toBeNull();
      expect(event.newValue).toBeNull();
    });

    it('uses priorEffectiveValue when unsetting a key that has no prior event', async () => {
      // Defensive: even though `config.unset` on an empty
      // runtime layer is a no-op semantically, the audit row
      // should still capture the engine's effective value so the
      // history view reads `default → null` rather than
      // `null → null`.
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });
      const event = await repo.unset(
        { key: 'decay.pinnedFloor', source: 'cli', priorEffectiveValue: 0.5 },
        { actor: cliActor },
      );
      expect(event.oldValue).toBe(0.5);
      expect(event.newValue).toBeNull();
    });
  });

  describe('currentValues', () => {
    it('returns an empty map when no events have been recorded', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db);
      const map = await repo.currentValues();
      expect(map.size).toBe(0);
    });

    it('returns the latest set value per key with provenance', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });
      await repo.set({ key: 'decay.pinnedFloor', value: 0.3, source: 'cli' }, { actor: cliActor });
      await repo.set({ key: 'decay.pinnedFloor', value: 0.6, source: 'mcp' }, { actor: mcpActor });
      await repo.set(
        { key: 'memory.list.defaultLimit', value: 25, source: 'cli' },
        { actor: cliActor },
      );

      const map = await repo.currentValues();
      expect(map.size).toBe(2);
      expect(map.get('decay.pinnedFloor')).toEqual({
        key: 'decay.pinnedFloor',
        value: 0.6,
        source: 'mcp',
        setAt: fixedClock,
        setBy: mcpActor,
      });
      expect(map.get('memory.list.defaultLimit')?.value).toBe(25);
    });

    it('omits keys whose latest event is an unset', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });
      await repo.set({ key: 'decay.pinnedFloor', value: 0.3, source: 'cli' }, { actor: cliActor });
      await repo.unset({ key: 'decay.pinnedFloor', source: 'cli' }, { actor: cliActor });

      const map = await repo.currentValues();
      expect(map.has('decay.pinnedFloor')).toBe(false);
    });
  });

  describe('history', () => {
    it('returns all events for a key oldest-first', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });
      await repo.set({ key: 'decay.pinnedFloor', value: 0.1, source: 'cli' }, { actor: cliActor });
      await repo.set({ key: 'decay.pinnedFloor', value: 0.2, source: 'cli' }, { actor: cliActor });
      await repo.unset({ key: 'decay.pinnedFloor', source: 'mcp' }, { actor: mcpActor });
      await repo.set(
        { key: 'memory.list.defaultLimit', value: 10, source: 'cli' },
        { actor: cliActor },
      );

      const history = await repo.history('decay.pinnedFloor');
      expect(history).toHaveLength(3);
      expect(history.map((e) => e.newValue)).toEqual([0.1, 0.2, null]);
      expect(history.map((e) => e.oldValue)).toEqual([null, 0.1, 0.2]);
    });

    it('respects the limit parameter', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });
      for (let i = 0; i < 5; i += 1) {
        await repo.set(
          { key: 'decay.pinnedFloor', value: i / 10, source: 'cli' },
          { actor: cliActor },
        );
      }
      const history = await repo.history('decay.pinnedFloor', 2);
      expect(history).toHaveLength(2);
      expect(history[0]?.newValue).toBe(0);
    });

    it('throws on a non-positive limit', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db);
      await expect(repo.history('decay.pinnedFloor', 0)).rejects.toThrow(/positive integer/);
      await expect(repo.history('decay.pinnedFloor', -1)).rejects.toThrow(/positive integer/);
      await expect(repo.history('decay.pinnedFloor', 1.5)).rejects.toThrow(/positive integer/);
    });

    it('returns an empty array for keys with no events', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db);
      const history = await repo.history('decay.pinnedFloor');
      expect(history).toEqual([]);
    });
  });

  describe('round-trip', () => {
    it('preserves complex JSON values through set/currentValues', async () => {
      const handle = await fixture();
      const repo = createConfigRepository(handle.db, {
        clock: () => fixedClock,
        eventIdFactory: counterFactory('CE'),
      });
      const rules = [{ id: 'email', pattern: '\\b\\S+@\\S+\\b', replacement: '<email>' }];
      await repo.set({ key: 'scrubber.rules', value: rules, source: 'cli' }, { actor: cliActor });
      const map = await repo.currentValues();
      expect(map.get('scrubber.rules')?.value).toEqual(rules);
    });
  });
});
