// `memento status` — single-line "what does my install look like?"
//
// Where `context` dumps the full registry+config snapshot in
// JSON, `status` is the human-friendly equivalent: a small
// summary that fits on one screen and answers "is memento
// holding anything? when did it last change? how big is it?"
// without forcing the operator to count rows in JSON.
//
// Read-only. Opens the database, queries a handful of
// aggregate stats, closes. Surfaces every count even when zero
// so the output is shape-stable across installs.

import { stat } from 'node:fs/promises';

import type { MementoApp } from '@psraghuveer/memento-core';
import { type Result, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';
import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Stable contract for `memento status`. */
export interface StatusSnapshot {
  readonly version: string;
  readonly dbPath: string;
  /** Database file size in bytes. `null` for `:memory:`. */
  readonly dbBytes: number | null;
  readonly memoryCount: number;
  readonly memoryByKind: Readonly<Record<string, number>>;
  readonly conflictCount: number;
  /** ISO timestamp of the latest memory event, or `null`. */
  readonly lastEventAt: string | null;
  /** Whether vector retrieval is enabled. */
  readonly vectorEnabled: boolean;
}

export const statusCommand: LifecycleCommand = {
  name: 'status',
  description: 'Print a one-screen summary of the install (counts, last event, db size)',
  run: runStatus,
};

export async function runStatus(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<StatusSnapshot>> {
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  const app = opened.value;
  try {
    const snapshot = await collect(app, input.env.dbPath);
    return ok(snapshot);
  } finally {
    await app.shutdown();
  }
}

async function collect(app: MementoApp, dbPath: string): Promise<StatusSnapshot> {
  const raw = app.db.raw;
  const total = (raw.prepare('select count(*) as n from memories').get() as { n: number }).n;
  const byKindRows = raw
    .prepare(
      "select kind_type as kind, count(*) as n from memories where status = 'active' group by kind_type",
    )
    .all() as ReadonlyArray<{ kind: string; n: number }>;
  const memoryByKind: Record<string, number> = {};
  for (const row of byKindRows) memoryByKind[row.kind] = row.n;
  const conflictRow = raw
    .prepare('select count(*) as n from conflicts where resolved_at is null')
    .get() as { n: number } | undefined;
  const lastEventRow = raw.prepare('select at from memory_events order by at desc limit 1').get() as
    | { at: string }
    | undefined;
  return {
    version: resolveVersion(),
    dbPath,
    dbBytes: dbPath === ':memory:' ? null : await fileSize(dbPath),
    memoryCount: total,
    memoryByKind,
    conflictCount: conflictRow?.n ?? 0,
    lastEventAt: lastEventRow?.at ?? null,
    vectorEnabled: app.configStore.get('retrieval.vector.enabled') === true,
  };
}

async function fileSize(p: string): Promise<number | null> {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return null;
  }
}
