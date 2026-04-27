import { CONFIG_KEYS } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import type { ConfigCurrentEntry } from '../../src/config/config-repository.js';
import { createConfigStore, createMutableConfigStore } from '../../src/config/config-store.js';

describe('createConfigStore', () => {
  it('returns the registered default when no override is supplied', () => {
    const store = createConfigStore();
    expect(store.get('decay.pinnedFloor')).toBe(CONFIG_KEYS['decay.pinnedFloor'].default);
    expect(store.get('memory.list.maxLimit')).toBe(CONFIG_KEYS['memory.list.maxLimit'].default);
    expect(store.get('storage.busyTimeoutMs')).toBe(CONFIG_KEYS['storage.busyTimeoutMs'].default);
  });

  it('returns the override when supplied and valid', () => {
    const store = createConfigStore({
      'decay.pinnedFloor': 0.75,
      'memory.list.defaultLimit': 25,
    });
    expect(store.get('decay.pinnedFloor')).toBe(0.75);
    expect(store.get('memory.list.defaultLimit')).toBe(25);
  });

  it('falls back to defaults for keys not overridden', () => {
    const store = createConfigStore({ 'decay.pinnedFloor': 0.6 });
    expect(store.get('decay.pinnedFloor')).toBe(0.6);
    expect(store.get('decay.archiveThreshold')).toBe(CONFIG_KEYS['decay.archiveThreshold'].default);
  });

  it('throws on construction when an override fails its schema', () => {
    expect(() => createConfigStore({ 'decay.pinnedFloor': 1.5 })).toThrow(/decay\.pinnedFloor/);
    expect(() => createConfigStore({ 'conflict.fact.overlapThreshold': 0 })).toThrow(
      /conflict\.fact\.overlapThreshold/,
    );
    expect(() => createConfigStore({ 'memory.list.maxLimit': -10 })).toThrow(
      /memory\.list\.maxLimit/,
    );
  });

  it('treats undefined overrides as absent', () => {
    // exactOptionalPropertyTypes forbids passing `undefined`
    // explicitly through the typed signature, so we route via a
    // structural cast to confirm the runtime fallback path.
    const store = createConfigStore({
      'decay.pinnedFloor': undefined,
    } as unknown as Parameters<typeof createConfigStore>[0]);
    expect(store.get('decay.pinnedFloor')).toBe(CONFIG_KEYS['decay.pinnedFloor'].default);
  });

  it('returns a frozen store', () => {
    const store = createConfigStore();
    expect(Object.isFrozen(store)).toBe(true);
  });

  it('every registry key resolves through the store with default value', () => {
    const store = createConfigStore();
    for (const name of Object.keys(CONFIG_KEYS) as (keyof typeof CONFIG_KEYS)[]) {
      expect(store.get(name)).toEqual(CONFIG_KEYS[name].default);
    }
  });

  describe('entry/entries (provenance)', () => {
    it('returns a default-source entry for keys with no override', () => {
      const store = createConfigStore({}, { clock: () => '2025-01-01T00:00:00.000Z' as never });
      const entry = store.entry('decay.pinnedFloor');
      expect(entry).toEqual({
        key: 'decay.pinnedFloor',
        value: CONFIG_KEYS['decay.pinnedFloor'].default,
        source: 'default',
        setAt: '2025-01-01T00:00:00.000Z',
        setBy: null,
      });
    });

    it('attributes override values to source `cli`', () => {
      const store = createConfigStore(
        { 'decay.pinnedFloor': 0.42 },
        { clock: () => '2025-01-01T00:00:00.000Z' as never },
      );
      const entry = store.entry('decay.pinnedFloor');
      expect(entry.value).toBe(0.42);
      expect(entry.source).toBe('cli');
      expect(entry.setBy).toBeNull();
    });

    it('entries() enumerates all registered keys', () => {
      const store = createConfigStore();
      const entries = store.entries();
      expect(entries.length).toBe(Object.keys(CONFIG_KEYS).length);
      expect(entries.map((e) => e.key)).toContain('decay.pinnedFloor');
    });

    it('entries(prefix) filters by dotted prefix', () => {
      const store = createConfigStore();
      const decay = store.entries('decay.');
      expect(decay.length).toBeGreaterThan(0);
      for (const entry of decay) {
        expect(entry.key.startsWith('decay.')).toBe(true);
      }
    });
  });
});

describe('createMutableConfigStore', () => {
  const cliEntry = (key: string, value: unknown): ConfigCurrentEntry => ({
    key,
    value,
    source: 'cli',
    setAt: '2025-01-01T00:00:00.000Z' as never,
    setBy: { type: 'cli' },
  });
  const mcpEntry = (key: string, value: unknown): ConfigCurrentEntry => ({
    key,
    value,
    source: 'mcp',
    setAt: '2025-01-02T00:00:00.000Z' as never,
    setBy: { type: 'mcp', agent: 'agent-x' },
  });

  it('falls back to defaults when no layer has the key', () => {
    const store = createMutableConfigStore();
    expect(store.get('decay.pinnedFloor')).toBe(CONFIG_KEYS['decay.pinnedFloor'].default);
    expect(store.entry('decay.pinnedFloor').source).toBe('default');
  });

  it('persisted layer wins over baseOverrides which wins over defaults', () => {
    const persisted = new Map<string, ConfigCurrentEntry>([
      ['decay.pinnedFloor', mcpEntry('decay.pinnedFloor', 0.9)],
    ]);
    const store = createMutableConfigStore({
      baseOverrides: {
        'decay.pinnedFloor': 0.5,
        'memory.list.defaultLimit': 25,
      },
      persisted,
    });
    expect(store.get('decay.pinnedFloor')).toBe(0.9);
    expect(store.entry('decay.pinnedFloor').source).toBe('mcp');
    expect(store.get('memory.list.defaultLimit')).toBe(25);
    expect(store.entry('memory.list.defaultLimit').source).toBe('cli');
  });

  it('apply() of a set event updates value, source, actor and timestamp', () => {
    const store = createMutableConfigStore();
    store.apply({
      id: 'CE0000000000000000000001' as never,
      key: 'decay.pinnedFloor',
      oldValue: null,
      newValue: 0.7,
      source: 'cli',
      actor: { type: 'cli' },
      at: '2025-02-01T00:00:00.000Z' as never,
    });
    const entry = store.entry('decay.pinnedFloor');
    expect(entry.value).toBe(0.7);
    expect(entry.source).toBe('cli');
    expect(entry.setAt).toBe('2025-02-01T00:00:00.000Z');
    expect(entry.setBy).toEqual({ type: 'cli' });
  });

  it('apply() of an unset event removes the runtime override', () => {
    const persisted = new Map<string, ConfigCurrentEntry>([
      ['decay.pinnedFloor', cliEntry('decay.pinnedFloor', 0.7)],
    ]);
    const store = createMutableConfigStore({ persisted });
    expect(store.get('decay.pinnedFloor')).toBe(0.7);
    store.apply({
      id: 'CE0000000000000000000002' as never,
      key: 'decay.pinnedFloor',
      oldValue: 0.7,
      newValue: null,
      source: 'cli',
      actor: { type: 'cli' },
      at: '2025-02-02T00:00:00.000Z' as never,
    });
    expect(store.get('decay.pinnedFloor')).toBe(CONFIG_KEYS['decay.pinnedFloor'].default);
    expect(store.entry('decay.pinnedFloor').source).toBe('default');
  });

  it('apply() unset reverts to baseOverrides, not all the way to default', () => {
    const persisted = new Map<string, ConfigCurrentEntry>([
      ['decay.pinnedFloor', mcpEntry('decay.pinnedFloor', 0.9)],
    ]);
    const store = createMutableConfigStore({
      baseOverrides: { 'decay.pinnedFloor': 0.5 },
      persisted,
    });
    store.apply({
      id: 'CE0000000000000000000003' as never,
      key: 'decay.pinnedFloor',
      oldValue: 0.9,
      newValue: null,
      source: 'mcp',
      actor: { type: 'mcp', agent: 'agent-x' },
      at: '2025-02-03T00:00:00.000Z' as never,
    });
    expect(store.get('decay.pinnedFloor')).toBe(0.5);
    expect(store.entry('decay.pinnedFloor').source).toBe('cli');
  });

  it('does not observe later mutations to the supplied persisted map', () => {
    const persisted = new Map<string, ConfigCurrentEntry>([
      ['decay.pinnedFloor', cliEntry('decay.pinnedFloor', 0.5)],
    ]);
    const store = createMutableConfigStore({ persisted });
    persisted.set('decay.pinnedFloor', cliEntry('decay.pinnedFloor', 0.99));
    expect(store.get('decay.pinnedFloor')).toBe(0.5);
  });

  it('throws on construction when a baseOverride fails its schema', () => {
    expect(() => createMutableConfigStore({ baseOverrides: { 'decay.pinnedFloor': 1.5 } })).toThrow(
      /decay\.pinnedFloor/,
    );
  });
});
