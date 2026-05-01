// `memento backup` — point-in-time copy of the SQLite database.
//
// Uses SQLite's `VACUUM INTO` so:
//   - the operation is safe against a concurrently-running
//     `memento serve` (better-sqlite3's WAL handling means the
//     copy reflects a consistent snapshot, no torn writes);
//   - the destination file is auto-vacuumed (smaller than a
//     plain file copy when the source has churned through many
//     deletes / superseded rows);
//   - we don't need to roll our own page-by-page copy or shell
//     out to `sqlite3 .backup`.
//
// Read-only with respect to the source database. The destination
// path is created (or overwritten if `--force` is set); the
// command refuses to overwrite an existing file otherwise so a
// fat-fingered path doesn't silently destroy a previous backup.

import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';
import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Stable contract for `memento backup`. */
export interface BackupSnapshot {
  readonly version: string;
  readonly source: string;
  readonly destination: string;
  readonly bytes: number;
  readonly elapsedMs: number;
}

export const backupCommand: LifecycleCommand = {
  name: 'backup',
  description: 'Create a point-in-time copy of the database (uses SQLite VACUUM INTO)',
  run: runBackup,
};

export async function runBackup(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<BackupSnapshot>> {
  const parsed = parseSubargs(input.subargs);
  if (!parsed.ok) return parsed;
  const { destination, force } = parsed.value;

  if (input.env.dbPath === ':memory:') {
    return err({
      code: 'INVALID_INPUT',
      message: 'backup is not supported for :memory: databases',
    });
  }
  const absDest = path.resolve(destination);
  if (existsSync(absDest) && !force) {
    return err({
      code: 'INVALID_INPUT',
      message: `backup destination '${absDest}' already exists; pass --force to overwrite`,
    });
  }
  // VACUUM INTO cannot overwrite an existing file — SQLite raises
  // "output file already exists". Remove the stale destination so
  // --force semantics work as advertised.
  if (force && existsSync(absDest)) {
    unlinkSync(absDest);
  }
  mkdirSync(path.dirname(absDest), { recursive: true });

  const start = Date.now();
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  const app = opened.value;
  try {
    // VACUUM INTO does not accept bound parameters; the
    // destination must be embedded in the SQL string. We
    // single-quote-escape to defend against paths containing
    // apostrophes (rare but legal on macOS / Linux).
    const escaped = absDest.replace(/'/gu, "''");
    app.db.raw.exec(`vacuum into '${escaped}'`);
  } finally {
    app.close();
  }

  const bytes = statSync(absDest).size;
  return ok({
    version: resolveVersion(),
    source: input.env.dbPath,
    destination: absDest,
    bytes,
    elapsedMs: Date.now() - start,
  });
}

interface BackupSubargs {
  readonly destination: string;
  readonly force: boolean;
}

function parseSubargs(subargs: readonly string[]): Result<BackupSubargs> {
  let destination: string | undefined;
  let force = false;
  for (let i = 0; i < subargs.length; i += 1) {
    const arg = subargs[i] as string;
    if (arg === '--force' || arg === '-f') {
      force = true;
      continue;
    }
    if (arg === '--out' || arg === '-o') {
      destination = subargs[++i];
      continue;
    }
    if (arg.startsWith('--out=')) {
      destination = arg.slice('--out='.length);
      continue;
    }
    if (!arg.startsWith('-') && destination === undefined) {
      destination = arg;
      continue;
    }
    return err({ code: 'INVALID_INPUT', message: `unknown argument '${arg}' for 'backup'` });
  }
  if (destination === undefined || destination.length === 0) {
    return err({
      code: 'INVALID_INPUT',
      message: 'backup requires a destination path (e.g. `memento backup ./memento.bak.db`)',
    });
  }
  return ok({ destination, force });
}
