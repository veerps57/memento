// `config.*` command set.
//
// Wraps the `ConfigRepository` (the audit log) and the
// `MutableConfigStore` (the in-memory layered view) behind the
// `Command` contract. Pattern matches the rest of the registry:
// each handler runs a `runRepo`-style wrapper that catches
// throws and projects them to `Result.err(MementoError)`.
//
// Surfaces: every command is exposed on both `mcp` and `cli` —
// per ADR-0003 the registry is the only spec; adapters project
// it without omissions.
//
// Source attribution for `config.set` / `config.unset` derives
// from `ctx.actor.type`: `'cli'` actors produce `cli`-source
// events, `'mcp'` actors produce `mcp`-source events. Other
// actor types (`scheduler`, `system`) are not legitimate
// callers — the audit log distinguishes operator intent from
// automation, and only operators set config in v1. Such calls
// return `INVALID_INPUT`.
//
// Immutable keys (`mutable: false` in the registry) are
// rejected with `IMMUTABLE`. Per the architecture doc
// (`docs/architecture/config.md`), a small set of keys is
// pinned at server start because changing them at runtime would
// require expensive reindex / restart work the engine does not
// (yet) automate.

import {
  CONFIG_KEYS,
  type ConfigEntry,
  ConfigEntrySchema,
  type ConfigEvent,
  ConfigEventSchema,
  type ConfigKey,
  type ConfigSource,
  type MementoError,
  type Result,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import { z } from 'zod';
import type { ConfigRepository } from '../../config/config-repository.js';
import type { MutableConfigStore } from '../../config/config-store.js';
import { repoErrorToMementoError } from '../errors.js';
import type { AnyCommand, Command, CommandContext } from '../types.js';
import {
  ConfigHistoryInputSchema,
  ConfigKeyInputSchema,
  ConfigListInputSchema,
  ConfigSetInputSchema,
} from './inputs.js';

// All `config.*` commands surface on the dashboard so the
// dashboard's config view (read + edit) works. The destructive
// bypass an attacker could cook up via
// `config.set scrubber.enabled false` is closed by marking
// `scrubber.enabled` and `scrubber.rules` immutable in
// `packages/schema/src/config-keys.ts`; the immutability gate
// fires regardless of which surface invoked the command.
const SURFACES = ['mcp', 'cli', 'dashboard'] as const;

const ConfigEntryListOutputSchema = z.array(ConfigEntrySchema);
const ConfigEventListOutputSchema = z.array(ConfigEventSchema);

async function runRepo<T>(op: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(repoErrorToMementoError(error, op));
  }
}

/**
 * Map an actor to the `ConfigSource` value recorded on the
 * audit event. Returns `null` for actor types that are not
 * legitimate config callers; the handler turns that into an
 * `INVALID_INPUT` error.
 */
function sourceForActor(ctx: CommandContext): ConfigSource | null {
  switch (ctx.actor.type) {
    case 'cli':
      return 'cli';
    case 'mcp':
      return 'mcp';
    default:
      return null;
  }
}

function invalidActorError(op: string, ctx: CommandContext): MementoError {
  return {
    code: 'INVALID_INPUT',
    message: `${op}: actor type '${ctx.actor.type}' may not mutate configuration`,
  };
}

function immutableKeyError(op: string, key: ConfigKey): MementoError {
  return {
    code: 'IMMUTABLE',
    message: `${op}: '${key}' is pinned at server start and cannot be changed at runtime`,
  };
}

function valueValidationError(op: string, key: ConfigKey, issues: unknown): MementoError {
  return {
    code: 'INVALID_INPUT',
    message: `${op}: value failed schema for '${key}'`,
    details: { key, issues },
  };
}

export interface CreateConfigCommandsDeps {
  readonly configRepository: ConfigRepository;
  readonly configStore: MutableConfigStore;
}

export function createConfigCommands(deps: CreateConfigCommandsDeps): readonly AnyCommand[] {
  const { configRepository: repo, configStore: store } = deps;

  const get: Command<typeof ConfigKeyInputSchema, typeof ConfigEntrySchema> = {
    name: 'config.get',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: ConfigKeyInputSchema,
    outputSchema: ConfigEntrySchema,
    metadata: {
      description: 'Resolved value for one config key, with source / actor / timestamp.',
    },
    handler: async (input) => ok(store.entry(input.key)),
  };

  const list: Command<typeof ConfigListInputSchema, typeof ConfigEntryListOutputSchema> = {
    name: 'config.list',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: ConfigListInputSchema,
    outputSchema: ConfigEntryListOutputSchema,
    metadata: {
      description:
        'Enumerate all registered config keys with their resolved values and provenance. Optional dotted prefix filter.',
    },
    handler: async (input) => {
      const entries = store.entries(input.prefix);
      // `entries` returns a readonly array; clone for the output
      // contract (Zod array parses a fresh array anyway).
      return ok(entries.slice() as ConfigEntry[]);
    },
  };

  const set: Command<typeof ConfigSetInputSchema, typeof ConfigEntrySchema> = {
    name: 'config.set',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: ConfigSetInputSchema,
    outputSchema: ConfigEntrySchema,
    metadata: {
      description:
        'Set a config key at runtime. Persists a `ConfigEvent` to the audit log and updates the in-memory store. Rejects keys marked `mutable: false` with IMMUTABLE.',
    },
    handler: async (input, ctx) => {
      const source = sourceForActor(ctx);
      if (source === null) return err(invalidActorError('config.set', ctx));
      const key = input.key as ConfigKey;
      const def = CONFIG_KEYS[key];
      if (!def.mutable) return err(immutableKeyError('config.set', key));
      const parsed = def.schema.safeParse(input.value);
      if (!parsed.success) {
        return err(valueValidationError('config.set', key, parsed.error.issues));
      }
      return await runRepo('config.set', async () => {
        // Stamp the engine's effective value at the moment of the
        // edit as the event's `oldValue` when no prior event
        // exists for this key — otherwise the audit chain reads
        // `null → newValue` for every first-time edit, which is
        // visible (and confusing) in the dashboard's history view.
        const priorEffectiveValue = store.entry(key).value;
        const event = await repo.set(
          { key, value: parsed.data, source, priorEffectiveValue },
          { actor: ctx.actor },
        );
        store.apply(event);
        return store.entry(key);
      });
    },
  };

  const unset: Command<typeof ConfigKeyInputSchema, typeof ConfigEntrySchema> = {
    name: 'config.unset',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: ConfigKeyInputSchema,
    outputSchema: ConfigEntrySchema,
    metadata: {
      description:
        'Clear the runtime override for a config key. The key reverts to whichever lower layer (defaults / startup overrides) had it last. Persists a `ConfigEvent` with `newValue: null`.',
    },
    handler: async (input, ctx) => {
      const source = sourceForActor(ctx);
      if (source === null) return err(invalidActorError('config.unset', ctx));
      const key = input.key as ConfigKey;
      // Immutable keys cannot be set; unsetting is also rejected
      // for consistency — the audit log should not record an
      // event whose intent is "revert this key", because the
      // runtime layer never had a value here.
      if (!CONFIG_KEYS[key].mutable) {
        return err(immutableKeyError('config.unset', key));
      }
      return await runRepo('config.unset', async () => {
        const priorEffectiveValue = store.entry(key).value;
        const event = await repo.unset({ key, source, priorEffectiveValue }, { actor: ctx.actor });
        store.apply(event);
        return store.entry(key);
      });
    },
  };

  const history: Command<typeof ConfigHistoryInputSchema, typeof ConfigEventListOutputSchema> = {
    name: 'config.history',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: ConfigHistoryInputSchema,
    outputSchema: ConfigEventListOutputSchema,
    metadata: {
      description: 'All `ConfigEvent`s for one key, oldest-first. Optional `limit`.',
      mcpName: 'list_config_history',
    },
    handler: async (input) =>
      runRepo('config.history', async (): Promise<ConfigEvent[]> => {
        return await repo.history(input.key as ConfigKey, input.limit ?? undefined);
      }),
  };

  return Object.freeze([get, list, set, unset, history]) as readonly AnyCommand[];
}
