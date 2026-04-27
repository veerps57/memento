// ConfigStore — typed read accessor over the `CONFIG_KEYS`
// registry from `@psraghuveer/memento-schema`, with provenance and an
// optional mutation surface for the runtime layer.
//
// Two flavours, both implementing `ConfigStore`:
//
//   - `createConfigStore(overrides?)` — frozen, read-only.
//     Used by tests, the decay engine's static config snapshot,
//     and any caller that just wants "defaults + an override
//     map". The overrides layer is attributed to source `cli`,
//     which matches its semantic role today (the `configOverrides`
//     argument flows from CLI flags / programmatic startup).
//
//   - `createMutableConfigStore({ baseOverrides?, persisted? })`
//     — read-mostly, with `apply(event)` for runtime mutation
//     by `config.set` / `config.unset`. Owns two layers:
//       * baseOverrides: the same shape as `createConfigStore`,
//         attributed to `cli` (CLI flags / startup options).
//       * persisted: the runtime layer loaded from
//         `ConfigRepository.currentValues()` — each entry
//         carries its own source (`cli` or `mcp`), actor, and
//         timestamp. Persisted wins over baseOverrides, both
//         win over defaults.
//
// `entry(key)` returns the full `ConfigEntry` (value plus
// provenance) for any key, falling back to a synthetic
// default-source entry when no layer has set the key.
// `entries(prefix?)` enumerates the registered key set,
// applying the same layering.
//
// Mutation goes through `apply(event)`, which is called by the
// `config.set` / `config.unset` commands AFTER the event has
// been persisted by `ConfigRepository`. Apply order matches the
// log: the latest event wins. Apply is non-throwing — the
// command layer is responsible for validation; by the time we
// see an event it has already been written to the audit log.

import {
  CONFIG_KEYS,
  CONFIG_KEY_NAMES,
  type ConfigEntry,
  type ConfigEvent,
  type ConfigKey,
  type ConfigSource,
  type ConfigValueOf,
  type Timestamp,
} from '@psraghuveer/memento-schema';
import type { ConfigCurrentEntry } from './config-repository.js';

/**
 * Read-only view over the resolved configuration. Subsystems
 * should accept a `ConfigStore` (typically via a `deps` object)
 * rather than reaching for module-level constants.
 */
export interface ConfigStore {
  /** Resolved value for `key`, narrowly typed by the registry. */
  get<K extends ConfigKey>(key: K): ConfigValueOf<K>;
  /**
   * Resolved entry with provenance. Keys with no override fall
   * back to a synthetic default-source entry whose `setAt` is
   * the store's construction time and whose `setBy` is `null`.
   */
  entry(key: ConfigKey): ConfigEntry;
  /**
   * All registered keys, optionally filtered by dotted prefix
   * (e.g. `'retrieval.'`). Order is the registry's declaration
   * order, which is stable across builds and groups
   * subsystem-by-subsystem.
   */
  entries(prefix?: string): readonly ConfigEntry[];
}

/**
 * Mutable runtime store. Adds {@link MutableConfigStore.apply}
 * for runtime mutation by `config.set` / `config.unset` after
 * the corresponding event has been persisted.
 */
export interface MutableConfigStore extends ConfigStore {
  /**
   * Fold one persisted event into the runtime layer:
   *   - `newValue !== null` → set the runtime entry to
   *     `{ value, source, setAt, setBy }`.
   *   - `newValue === null` → remove the runtime entry; the
   *     key reverts to whichever lower layer had it last.
   *
   * The event is assumed to be valid (it has been parsed by
   * `ConfigEventSchema`) and to have been persisted before this
   * call. `apply` is therefore non-throwing.
   */
  apply(event: ConfigEvent): void;
}

/**
 * Partial map keyed by `ConfigKey` with per-key value typing.
 * Used both for the override argument and (later) for the
 * persisted layer snapshots.
 */
export type ConfigOverrides = {
  readonly [K in ConfigKey]?: ConfigValueOf<K>;
};

/**
 * Build a frozen `ConfigStore` from an override map. Each
 * override is validated against the corresponding key's schema;
 * the first invalid override throws an error pointing at the
 * offending key so the misconfiguration is obvious in the stack
 * trace.
 *
 * Calling without arguments yields a store backed entirely by
 * registered defaults — the right choice for first-run servers
 * and the typical baseline for tests.
 */
export function createConfigStore(
  overrides: ConfigOverrides = {},
  options: { clock?: () => Timestamp } = {},
): ConfigStore {
  const clock = options.clock ?? defaultClock;
  const at = clock();

  const validatedOverrides: Partial<Record<ConfigKey, unknown>> = {};
  for (const name of CONFIG_KEY_NAMES) {
    const value = overrides[name];
    if (value === undefined) continue;
    validatedOverrides[name] = validateOverride(name, value);
  }

  function entryFor(key: ConfigKey): ConfigEntry {
    if (key in validatedOverrides) {
      return {
        key,
        value: validatedOverrides[key],
        // The `configOverrides` argument feeds startup flags /
        // programmatic options, which the layering doc places
        // at the `cli` precedence level. File / env layers will
        // override this attribution when they land.
        source: 'cli',
        setAt: at,
        setBy: null,
      };
    }
    return {
      key,
      value: CONFIG_KEYS[key].default,
      source: 'default',
      setAt: at,
      setBy: null,
    };
  }

  return Object.freeze({
    get<K extends ConfigKey>(key: K): ConfigValueOf<K> {
      if (key in validatedOverrides) {
        return validatedOverrides[key] as ConfigValueOf<K>;
      }
      return CONFIG_KEYS[key].default as ConfigValueOf<K>;
    },
    entry(key: ConfigKey): ConfigEntry {
      return entryFor(key);
    },
    entries(prefix?: string): readonly ConfigEntry[] {
      const keys =
        prefix === undefined
          ? CONFIG_KEY_NAMES
          : CONFIG_KEY_NAMES.filter((k) => k.startsWith(prefix));
      return keys.map(entryFor);
    },
  });
}

export interface CreateMutableConfigStoreOptions {
  readonly baseOverrides?: ConfigOverrides;
  /**
   * Snapshot of the runtime layer, typically from
   * `ConfigRepository.currentValues()`. Each entry carries its
   * own source / actor / timestamp.
   */
  readonly persisted?: ReadonlyMap<string, ConfigCurrentEntry>;
  readonly clock?: () => Timestamp;
}

/**
 * Build a mutable runtime config store. Layering (low → high):
 * defaults → baseOverrides → persisted. Runtime mutation goes
 * through `apply(event)` after the event has been persisted.
 */
export function createMutableConfigStore(
  options: CreateMutableConfigStoreOptions = {},
): MutableConfigStore {
  const clock = options.clock ?? defaultClock;
  const at = clock();

  const validatedBase: Partial<Record<ConfigKey, unknown>> = {};
  if (options.baseOverrides !== undefined) {
    for (const name of CONFIG_KEY_NAMES) {
      const value = options.baseOverrides[name];
      if (value === undefined) continue;
      validatedBase[name] = validateOverride(name, value);
    }
  }

  // The runtime layer is mutable; we copy the persisted snapshot
  // so callers cannot accidentally observe later `apply` calls
  // through their own reference to the input map.
  const runtime = new Map<string, ConfigCurrentEntry>();
  if (options.persisted !== undefined) {
    for (const [key, entry] of options.persisted) runtime.set(key, entry);
  }

  function entryFor(key: ConfigKey): ConfigEntry {
    const fromRuntime = runtime.get(key);
    if (fromRuntime !== undefined) {
      return {
        key,
        value: fromRuntime.value,
        source: fromRuntime.source,
        setAt: fromRuntime.setAt,
        setBy: fromRuntime.setBy,
      };
    }
    if (key in validatedBase) {
      return {
        key,
        value: validatedBase[key],
        source: 'cli',
        setAt: at,
        setBy: null,
      };
    }
    return {
      key,
      value: CONFIG_KEYS[key].default,
      source: 'default',
      setAt: at,
      setBy: null,
    };
  }

  return Object.freeze({
    get<K extends ConfigKey>(key: K): ConfigValueOf<K> {
      const fromRuntime = runtime.get(key);
      if (fromRuntime !== undefined) return fromRuntime.value as ConfigValueOf<K>;
      if (key in validatedBase) return validatedBase[key] as ConfigValueOf<K>;
      return CONFIG_KEYS[key].default as ConfigValueOf<K>;
    },
    entry(key: ConfigKey): ConfigEntry {
      return entryFor(key);
    },
    entries(prefix?: string): readonly ConfigEntry[] {
      const keys =
        prefix === undefined
          ? CONFIG_KEY_NAMES
          : CONFIG_KEY_NAMES.filter((k) => k.startsWith(prefix));
      return keys.map(entryFor);
    },
    apply(event: ConfigEvent): void {
      if (event.newValue === null) {
        runtime.delete(event.key);
        return;
      }
      runtime.set(event.key, {
        key: event.key,
        value: event.newValue,
        source: event.source,
        setAt: event.at,
        setBy: event.actor,
      });
    },
  });
}

/**
 * Validate a single override against its registered schema.
 * Throws with the offending key in the message so the failure
 * point is obvious in stack traces.
 */
function validateOverride(name: ConfigKey, value: unknown): unknown {
  const def = CONFIG_KEYS[name];
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `config: invalid override for "${name}": ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

const defaultClock = (): Timestamp => new Date().toISOString() as Timestamp;

// Re-export `ConfigSource` so adapters that round-trip
// `ConfigEntry` values do not also have to import from
// `@psraghuveer/memento-schema` separately.
export type { ConfigSource };
