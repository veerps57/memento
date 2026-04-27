// `memento store migrate` lifecycle command.
//
// Runs every registered migration that has not been applied,
// then reports one outcome per migration in registry order.
// Idempotent by construction: the runner inside `@psraghuveer/memento-core`
// records every applied migration in a bookkeeping table and
// skips ones already recorded, so re-running is a no-op (every
// outcome reports `skipped`).
//
// Why this is a lifecycle command and not a registry command:
//
//   - It runs *before* any normal `createMementoApp` succeeds
//     against a fresh DB. Going through the registry would
//     require bootstrap to have completed first — circular.
//   - Its output is an operational status list, not domain
//     data; there is no input/output schema worth declaring at
//     the registry level.
//   - It is a one-off invocation per machine setup; the cost of
//     a separate code path is paid once.
//
// The default `migrateStore` implementation in `index.ts` opens
// a raw `MementoDatabase`, calls `migrateToLatest`, and closes
// the handle in a `finally`. Tests inject a fake to assert the
// rendered shape without touching SQLite.

import type { MigrationOutcome } from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/**
 * Shape of a single migration in the rendered output. Mirrors
 * `MigrationOutcome` from `@psraghuveer/memento-core` but is re-exported
 * here so consumers of `@psraghuveer/memento` don't have to import from
 * core directly.
 */
export interface StoreMigrateEntry {
  readonly name: string;
  readonly status: 'applied' | 'skipped';
}

/** Result payload of `memento store migrate`. */
export interface StoreMigrateSnapshot {
  readonly dbPath: string;
  readonly migrations: readonly StoreMigrateEntry[];
  readonly applied: number;
  readonly skipped: number;
}

export const storeMigrateCommand: LifecycleCommand = {
  name: 'store.migrate',
  description: 'Run pending database migrations against the configured store',
  run: runStoreMigrate,
};

export async function runStoreMigrate(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<StoreMigrateSnapshot>> {
  let outcomes: readonly MigrationOutcome[];
  try {
    outcomes = await deps.migrateStore({ dbPath: input.env.dbPath });
  } catch (cause) {
    return err({
      code: 'STORAGE_ERROR',
      message: `failed to migrate database at '${input.env.dbPath}': ${describe(cause)}`,
    });
  }

  let applied = 0;
  let skipped = 0;
  for (const o of outcomes) {
    if (o.status === 'applied') applied += 1;
    else skipped += 1;
  }

  return ok({
    dbPath: input.env.dbPath,
    migrations: outcomes.map((o) => ({ name: o.name, status: o.status })),
    applied,
    skipped,
  });
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
