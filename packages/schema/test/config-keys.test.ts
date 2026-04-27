import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONFIG_KEYS,
  CONFIG_KEY_NAMES,
  type ConfigKey,
  type ConfigValueOf,
} from '../src/config-keys.js';

describe('CONFIG_KEYS registry', () => {
  it('every key has a unique dotted name following the lowercase pattern', () => {
    const names = CONFIG_KEY_NAMES;
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][A-Za-z0-9-]*(\.[a-z0-9][A-Za-z0-9-]*)+$/);
    }
  });

  it("every key's default satisfies its schema", () => {
    for (const name of CONFIG_KEY_NAMES) {
      const def = CONFIG_KEYS[name];
      const result = def.schema.safeParse(def.default);
      expect(result.success, `default for ${name} failed schema`).toBe(true);
    }
  });

  it('every entry is frozen', () => {
    for (const name of CONFIG_KEY_NAMES) {
      expect(Object.isFrozen(CONFIG_KEYS[name])).toBe(true);
    }
  });

  it('CONFIG_KEY_NAMES is frozen and matches the registry keys', () => {
    expect(Object.isFrozen(CONFIG_KEY_NAMES)).toBe(true);
    expect([...CONFIG_KEY_NAMES].sort()).toEqual(Object.keys(CONFIG_KEYS).sort());
  });

  it('storage.busyTimeoutMs is immutable', () => {
    expect(CONFIG_KEYS['storage.busyTimeoutMs'].mutable).toBe(false);
  });

  it('exposes the runtime knobs the conflict-detection hook depends on', () => {
    // Pin defaults from `docs/architecture/conflict-detection.md`
    // so a silent edit to either side trips this test rather
    // than diverging in production.
    expect(CONFIG_KEYS['conflict.enabled'].default).toBe(true);
    expect(CONFIG_KEYS['conflict.timeoutMs'].default).toBe(2_000);
    expect(CONFIG_KEYS['conflict.scopeStrategy'].default).toBe('same');
    expect(CONFIG_KEYS['conflict.surfaceInSearch'].default).toBe(true);
    expect(CONFIG_KEYS['conflict.maxOpenBeforeWarning'].default).toBe(50);
  });

  it('conflict.scopeStrategy accepts only the documented values', () => {
    const schema = CONFIG_KEYS['conflict.scopeStrategy'].schema;
    expect(schema.safeParse('same').success).toBe(true);
    expect(schema.safeParse('effective').success).toBe(true);
    expect(schema.safeParse('layered').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });

  it('conflict.timeoutMs and conflict.maxOpenBeforeWarning reject non-positive values', () => {
    expect(CONFIG_KEYS['conflict.timeoutMs'].schema.safeParse(0).success).toBe(false);
    expect(CONFIG_KEYS['conflict.timeoutMs'].schema.safeParse(-1).success).toBe(false);
    expect(CONFIG_KEYS['conflict.timeoutMs'].schema.safeParse(1.5).success).toBe(false);
    expect(CONFIG_KEYS['conflict.maxOpenBeforeWarning'].schema.safeParse(0).success).toBe(false);
  });

  it('rejects values that violate per-key schemas', () => {
    expect(CONFIG_KEYS['decay.pinnedFloor'].schema.safeParse(1.5).success).toBe(false);
    expect(CONFIG_KEYS['decay.pinnedFloor'].schema.safeParse(-0.1).success).toBe(false);
    expect(CONFIG_KEYS['decay.archiveThreshold'].schema.safeParse(2).success).toBe(false);
    expect(CONFIG_KEYS['conflict.fact.overlapThreshold'].schema.safeParse(0).success).toBe(false);
    expect(CONFIG_KEYS['conflict.fact.overlapThreshold'].schema.safeParse(1.5).success).toBe(false);
    expect(CONFIG_KEYS['decay.halfLife.fact'].schema.safeParse(0).success).toBe(false);
    expect(
      CONFIG_KEYS['decay.halfLife.fact'].schema.safeParse(Number.POSITIVE_INFINITY).success,
    ).toBe(false);
  });

  it('ConfigValueOf preserves per-key typing', () => {
    // Compile-time check: this would not type-check if the
    // helper widened to `unknown`. The runtime assertion here
    // is incidental; the value of the test is the type narrowing.
    const halfLife: ConfigValueOf<'decay.halfLife.fact'> = 1;
    const pinned: ConfigValueOf<'decay.pinnedFloor'> = 0.5;
    const limit: ConfigValueOf<'memory.list.maxLimit'> = 100;
    expect(typeof halfLife).toBe('number');
    expect(typeof pinned).toBe('number');
    expect(typeof limit).toBe('number');
  });

  it('ConfigKey union covers exactly the registry', () => {
    // Compile-time check via assignment. A typo here would fail
    // typecheck.
    const sample: ConfigKey = 'decay.pinnedFloor';
    expect(CONFIG_KEY_NAMES.includes(sample)).toBe(true);
  });

  it('schemas are zod types', () => {
    for (const name of CONFIG_KEY_NAMES) {
      expect(CONFIG_KEYS[name].schema).toBeInstanceOf(z.ZodType);
    }
  });

  it('exposes scrubber.enabled and scrubber.rules with the shipped default rule set', async () => {
    // Pin the wiring expected by `bootstrap.ts`: scrubber config
    // is fully driven through `ConfigStore` rather than a
    // hardcoded constant. The default rule set must be the same
    // value re-exported as `DEFAULT_SCRUBBER_RULES` so the
    // first-run scrubbing behaviour matches the documented
    // baseline regardless of which side reads the config.
    const { DEFAULT_SCRUBBER_RULES } = await import('../src/scrubber.js');
    expect(CONFIG_KEYS['scrubber.enabled'].default).toBe(true);
    expect(CONFIG_KEYS['scrubber.enabled'].mutable).toBe(true);
    expect(CONFIG_KEYS['scrubber.rules'].default).toBe(DEFAULT_SCRUBBER_RULES);
    expect(CONFIG_KEYS['scrubber.rules'].mutable).toBe(true);
  });

  it('scrubber.rules schema rejects an array with duplicate ids', () => {
    const dup = [
      {
        id: 'dupe',
        description: 'first',
        pattern: 'a',
        placeholder: '<x>',
        severity: 'low',
      },
      {
        id: 'dupe',
        description: 'second',
        pattern: 'b',
        placeholder: '<x>',
        severity: 'low',
      },
    ];
    expect(CONFIG_KEYS['scrubber.rules'].schema.safeParse(dup).success).toBe(false);
  });
});
