import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONFIG_KEYS,
  CONFIG_KEY_NAMES,
  type ConfigKey,
  type ConfigValueOf,
  IMMUTABLE_CONFIG_KEY_NAMES,
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

  it('IMMUTABLE_CONFIG_KEY_NAMES exactly matches every key flagged mutable: false', () => {
    // Pinned because the dashboard's editor uses this list to
    // gate the inline editor (read-only vs editable). Drift
    // between the schema's `mutable: false` and the exported
    // constant would let the editor render for an immutable key
    // and surface IMMUTABLE on save instead of locking the row.
    const derivedFromRegistry = CONFIG_KEY_NAMES.filter(
      (name) => CONFIG_KEYS[name].mutable === false,
    );
    expect([...IMMUTABLE_CONFIG_KEY_NAMES].sort()).toEqual([...derivedFromRegistry].sort());
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
    //
    // Both keys are pinned at server start (`mutable: false`).
    // A prompt-injected assistant calling
    // `config.set scrubber.enabled false` before writing a
    // secret would otherwise be a one-shot bypass of the only
    // defence against accidentally persisting credentials.
    const { DEFAULT_SCRUBBER_RULES } = await import('../src/scrubber.js');
    expect(CONFIG_KEYS['scrubber.enabled'].default).toBe(true);
    expect(CONFIG_KEYS['scrubber.enabled'].mutable).toBe(false);
    expect(CONFIG_KEYS['scrubber.rules'].default).toBe(DEFAULT_SCRUBBER_RULES);
    expect(CONFIG_KEYS['scrubber.rules'].mutable).toBe(false);
  });

  it('exposes the packs.* knobs ADR-0020 promises', () => {
    // Pin the defaults referenced from `bootstrap.ts` and the
    // resolver so a silent edit on either side trips this test.
    expect(CONFIG_KEYS['packs.bundledRegistryPath'].default).toBeNull();
    expect(CONFIG_KEYS['packs.bundledRegistryPath'].mutable).toBe(false);
    expect(CONFIG_KEYS['packs.allowRemoteUrls'].default).toBe(true);
    expect(CONFIG_KEYS['packs.allowRemoteUrls'].mutable).toBe(true);
    expect(CONFIG_KEYS['packs.urlFetchTimeoutMs'].default).toBe(10_000);
    expect(CONFIG_KEYS['packs.maxPackSizeBytes'].default).toBe(1 * 1024 * 1024);
    expect(CONFIG_KEYS['packs.maxMemoriesPerPack'].default).toBe(200);
  });

  it('packs.maxPackSizeBytes rejects values below 1 KiB and above 64 MiB', () => {
    const schema = CONFIG_KEYS['packs.maxPackSizeBytes'].schema;
    expect(schema.safeParse(512).success).toBe(false);
    expect(schema.safeParse(1024).success).toBe(true);
    expect(schema.safeParse(64 * 1024 * 1024).success).toBe(true);
    expect(schema.safeParse(64 * 1024 * 1024 + 1).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
  });

  it('packs.maxMemoriesPerPack rejects non-positive and >10_000 values', () => {
    const schema = CONFIG_KEYS['packs.maxMemoriesPerPack'].schema;
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(10_000).success).toBe(true);
    expect(schema.safeParse(10_001).success).toBe(false);
  });

  it('packs.bundledRegistryPath accepts non-empty string or null', () => {
    const schema = CONFIG_KEYS['packs.bundledRegistryPath'].schema;
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse('/var/packs').success).toBe(true);
    expect(schema.safeParse('').success).toBe(false);
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
