// `memento context` — print the runtime context.
//
// Purpose: a single command that answers "what database, which
// commands, which config values would you run with right now?".
// It is the first command a new operator should run, the
// command an integration test calls to assert wiring, and the
// command a bug report should attach.
//
// Shape (`ContextSnapshot`):
//
//   - `version`          — CLI version string. Identifies the binary.
//   - `dbPath`           — the resolved DB path (after `--db`,
//                          `MEMENTO_DB`, default).
//   - `registry.commands`— every registered command's name,
//                          surfaces, sideEffect, description, in
//                          registration order.
//   - `config`           — resolved config snapshot, one entry per
//                          `ConfigKey`, with the value the
//                          subsystem would observe.
//
// The shape is the public contract. It is rendered identically
// by `renderResult` (json or text) so callers can pipe to `jq`
// or read on a terminal without thinking about it.
//
// Failure modes: the only thing that can go wrong here is
// `createApp` (typically `STORAGE_ERROR` for an unreachable DB
// path). We catch it, wrap it as `STORAGE_ERROR` if the
// underlying error isn't already a `Result`, and emit it through
// the standard error pipeline.

import { CONFIG_KEY_NAMES, type ConfigKey, type Result, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';
import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Public projection of one registry entry. */
export interface ContextCommandEntry {
  readonly name: string;
  readonly sideEffect: string;
  readonly surfaces: readonly string[];
  readonly description: string;
}

/** Output shape for `memento context`. Stable contract. */
export interface ContextSnapshot {
  readonly version: string;
  readonly dbPath: string;
  readonly registry: {
    readonly commands: readonly ContextCommandEntry[];
  };
  readonly config: Readonly<Record<ConfigKey, unknown>>;
}

export const contextCommand: LifecycleCommand = {
  name: 'context',
  description: 'Print runtime context (db, version, registered commands, config snapshot)',
  run: runContext,
};

export async function runContext(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<ContextSnapshot>> {
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  const app = opened.value;

  try {
    const commands: ContextCommandEntry[] = app.registry.list().map((cmd) => ({
      name: cmd.name,
      sideEffect: cmd.sideEffect,
      surfaces: [...cmd.surfaces],
      description: cmd.metadata.description,
    }));

    // Snapshot every key. Iteration order is registration order
    // from `CONFIG_KEY_NAMES`, which is what the reference doc
    // generator also relies on.
    const config: Partial<Record<ConfigKey, unknown>> = {};
    for (const key of CONFIG_KEY_NAMES) {
      config[key] = app.configStore.get(key);
    }

    return ok({
      version: resolveVersion(),
      dbPath: input.env.dbPath,
      registry: { commands },
      config: config as Record<ConfigKey, unknown>,
    });
  } finally {
    app.close();
  }
}
