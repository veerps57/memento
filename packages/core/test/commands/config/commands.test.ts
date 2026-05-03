// End-to-end tests for the `config.*` command set.
//
// Mirrors the conflict-embedding-compact fixture style: build
// the command set against a real ConfigRepository (in-memory
// SQLite) and a real MutableConfigStore, drive everything
// through `executeCommand`.

import type { ActorRef, ConfigEntry, ConfigEvent } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfigCommands } from '../../../src/commands/config/index.js';
import { executeCommand } from '../../../src/commands/execute.js';
import type { AnyCommand } from '../../../src/commands/types.js';
import { createConfigRepository } from '../../../src/config/config-repository.js';
import { createMutableConfigStore } from '../../../src/config/config-store.js';
import { openDatabase } from '../../../src/storage/database.js';
import { migrateToLatest } from '../../../src/storage/migrate.js';
import { MIGRATIONS } from '../../../src/storage/migrations/index.js';

interface OpenHandle {
  close(): void;
}
const handles: OpenHandle[] = [];

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
});

const cliActor: ActorRef = { type: 'cli' };
const mcpActor: ActorRef = { type: 'mcp', agent: 'agent-x' };
const schedulerActor: ActorRef = {
  type: 'scheduler',
  job: 'compact',
};
const fixedClock = '2025-01-01T00:00:00.000Z';

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    const num = String(i).padStart(24, '0');
    return `${prefix}${num}`;
  };
}

async function fixture() {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  const repo = createConfigRepository(handle.db, {
    clock: () => fixedClock as never,
    eventIdFactory: counterFactory('CE'),
  });
  const persisted = await repo.currentValues();
  const store = createMutableConfigStore({
    persisted,
    clock: () => fixedClock as never,
  });
  const cmds = createConfigCommands({
    configRepository: repo,
    configStore: store,
  });
  const byName = new Map<string, AnyCommand>(cmds.map((c) => [c.name, c] as const));
  return { repo, store, byName };
}

function get(byName: Map<string, AnyCommand>, name: string): AnyCommand {
  const cmd = byName.get(name);
  if (cmd === undefined) throw new Error(`missing command: ${name}`);
  return cmd;
}

describe('createConfigCommands', () => {
  it('exposes the v1 config.* set under both surfaces', async () => {
    const { byName } = await fixture();
    const names = ['config.get', 'config.list', 'config.set', 'config.unset', 'config.history'];
    for (const name of names) {
      const cmd = get(byName, name);
      expect(cmd.surfaces).toEqual(['mcp', 'cli']);
    }
  });

  it('classifies side-effects per the documented matrix', async () => {
    const { byName } = await fixture();
    expect(get(byName, 'config.get').sideEffect).toBe('read');
    expect(get(byName, 'config.list').sideEffect).toBe('read');
    expect(get(byName, 'config.set').sideEffect).toBe('write');
    expect(get(byName, 'config.unset').sideEffect).toBe('write');
    expect(get(byName, 'config.history').sideEffect).toBe('read');
  });

  describe('config.get', () => {
    it('returns the default-source entry for an unset key', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.get'),
        { key: 'decay.pinnedFloor' },
        { actor: cliActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const entry = res.value as ConfigEntry;
      expect(entry.key).toBe('decay.pinnedFloor');
      expect(entry.source).toBe('default');
      expect(entry.setBy).toBeNull();
    });

    it('rejects unknown keys at the input boundary as INVALID_INPUT', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.get'),
        { key: 'nope.not.a.key' },
        { actor: cliActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('config.set', () => {
    it('persists, applies, and returns the resolved entry with cli source', async () => {
      const { repo, byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 0.7 },
        { actor: cliActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const entry = res.value as ConfigEntry;
      expect(entry.value).toBe(0.7);
      expect(entry.source).toBe('cli');
      expect(entry.setBy).toEqual(cliActor);

      // The audit log saw the event too.
      const events = await repo.history('decay.pinnedFloor');
      expect(events).toHaveLength(1);
      expect(events[0]?.newValue).toBe(0.7);
    });

    it('attributes mcp-actor calls to source=mcp', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 0.4 },
        { actor: mcpActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      expect((res.value as ConfigEntry).source).toBe('mcp');
    });

    it('rejects scheduler / system actors with INVALID_INPUT', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 0.5 },
        { actor: schedulerActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('INVALID_INPUT');
      expect(res.error.message).toMatch(/scheduler/);
    });

    it('rejects values that fail the per-key schema with INVALID_INPUT', async () => {
      const { byName } = await fixture();
      // pinnedFloor is a probability in [0, 1]; 5 must fail.
      const res = await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 5 },
        { actor: cliActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('INVALID_INPUT');
      expect(res.error.message).toMatch(/decay\.pinnedFloor/);
    });

    it('rejects writes to immutable keys with IMMUTABLE', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.set'),
        { key: 'storage.busyTimeoutMs', value: 1000 },
        { actor: cliActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('IMMUTABLE');
      expect(res.error.message).toMatch(/storage\.busyTimeoutMs/);
    });

    // Phase 1 hardening: `scrubber.enabled` and `scrubber.rules`
    // are pinned at server start. A prompt-injected assistant
    // calling `config.set scrubber.enabled false` before writing
    // a secret must be rejected at this boundary — the scrubber
    // is the load-bearing defence against accidentally
    // persisting credentials.
    it('rejects writes to scrubber.enabled with IMMUTABLE', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.set'),
        { key: 'scrubber.enabled', value: false },
        { actor: cliActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('IMMUTABLE');
      expect(res.error.message).toMatch(/scrubber\.enabled/);
    });

    it('rejects writes to scrubber.rules with IMMUTABLE', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.set'),
        { key: 'scrubber.rules', value: [] },
        { actor: cliActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('IMMUTABLE');
      expect(res.error.message).toMatch(/scrubber\.rules/);
    });
  });

  describe('config.unset', () => {
    it('reverts a runtime override to the default', async () => {
      const { byName } = await fixture();
      await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 0.9 },
        { actor: cliActor },
      );
      const res = await executeCommand(
        get(byName, 'config.unset'),
        { key: 'decay.pinnedFloor' },
        { actor: cliActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const entry = res.value as ConfigEntry;
      expect(entry.source).toBe('default');
      expect(entry.setBy).toBeNull();
    });

    it('rejects immutable keys with IMMUTABLE', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.unset'),
        { key: 'retrieval.fts.tokenizer' },
        { actor: cliActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('IMMUTABLE');
    });

    it('rejects scheduler / system actors with INVALID_INPUT', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.unset'),
        { key: 'decay.pinnedFloor' },
        { actor: schedulerActor },
      );
      if (res.ok) throw new Error('expected err');
      expect(res.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('config.list', () => {
    it('returns every registered key, with provenance', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(get(byName, 'config.list'), {}, { actor: cliActor });
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const entries = res.value as readonly ConfigEntry[];
      expect(entries.length).toBeGreaterThanOrEqual(40);
      expect(entries.every((e) => typeof e.key === 'string' && typeof e.source === 'string')).toBe(
        true,
      );
    });

    it('honours the prefix filter', async () => {
      const { byName } = await fixture();
      const res = await executeCommand(
        get(byName, 'config.list'),
        { prefix: 'decay.' },
        { actor: cliActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const entries = res.value as readonly ConfigEntry[];
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.key.startsWith('decay.'))).toBe(true);
    });

    it('reflects runtime sets in subsequent reads', async () => {
      const { byName } = await fixture();
      await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 0.42 },
        { actor: mcpActor },
      );
      const res = await executeCommand(
        get(byName, 'config.list'),
        { prefix: 'decay.pinnedFloor' },
        { actor: cliActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const entries = res.value as readonly ConfigEntry[];
      const match = entries.find((e) => e.key === 'decay.pinnedFloor');
      expect(match?.value).toBe(0.42);
      expect(match?.source).toBe('mcp');
    });
  });

  describe('config.history', () => {
    it('returns events oldest-first for one key', async () => {
      const { byName } = await fixture();
      await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 0.1 },
        { actor: cliActor },
      );
      await executeCommand(
        get(byName, 'config.set'),
        { key: 'decay.pinnedFloor', value: 0.2 },
        { actor: cliActor },
      );
      await executeCommand(
        get(byName, 'config.unset'),
        { key: 'decay.pinnedFloor' },
        { actor: cliActor },
      );
      const res = await executeCommand(
        get(byName, 'config.history'),
        { key: 'decay.pinnedFloor' },
        { actor: cliActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const events = res.value as readonly ConfigEvent[];
      expect(events).toHaveLength(3);
      expect(events[0]?.newValue).toBe(0.1);
      expect(events[1]?.newValue).toBe(0.2);
      expect(events[2]?.newValue).toBeNull();
    });

    it('honours the limit', async () => {
      const { byName } = await fixture();
      for (const v of [0.1, 0.2, 0.3, 0.4]) {
        await executeCommand(
          get(byName, 'config.set'),
          { key: 'decay.pinnedFloor', value: v },
          { actor: cliActor },
        );
      }
      const res = await executeCommand(
        get(byName, 'config.history'),
        { key: 'decay.pinnedFloor', limit: 2 },
        { actor: cliActor },
      );
      if (!res.ok) throw new Error(`expected ok: ${res.error.code}`);
      const events = res.value as readonly ConfigEvent[];
      expect(events).toHaveLength(2);
    });
  });
});
