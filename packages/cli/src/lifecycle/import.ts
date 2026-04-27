// `memento import` lifecycle command.
//
// Reads a `memento-export/v1` JSONL artefact from disk (or stdin),
// validates it, and applies it to the configured database in a
// single transaction. The engine-level mechanics — header schema,
// SHA-256 footer, conflict policy, transactional apply — live in
// `@psraghuveer/memento-core`'s `importSnapshot`; this module owns the argv
// parsing, the source byte stream, and the CLI-shaped summary.
//
// Argv grammar:
//
//   memento import --in <path> [--dry-run] [--on-conflict skip|abort]
//
// `--dry-run` parses + validates the artefact (including the SHA-256
// check) but never opens a write transaction. `--on-conflict`
// defaults to `skip` — the most common case is "merge an artefact
// from another machine into mine and keep my local additions".
// `abort` is for the strict "must be empty target or fail" case.
//
// Note: this command does NOT auto-migrate the destination DB.
// Operators are expected to run `memento store migrate` first; the
// header's `schemaVersion <= MEMORY_SCHEMA_VERSION` handshake guards
// against importing an artefact authored against a *newer* engine.

import { readFile } from 'node:fs/promises';

import {
  type ImportConflictPolicy,
  type ImportSummary,
  importSnapshot,
  openDatabase,
} from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Operator-facing payload of `memento import`. */
export interface ImportSnapshotResult {
  readonly dbPath: string;
  readonly inPath: string;
  readonly schemaVersion: number;
  readonly applied: ImportSummary['applied'];
  readonly skipped: ImportSummary['skipped'];
  readonly dryRun: boolean;
}

interface ImportArgs {
  readonly in: string;
  readonly dryRun: boolean;
  readonly onConflict: ImportConflictPolicy;
}

export const importCommand: LifecycleCommand = {
  name: 'import',
  description:
    'Import a `memento-export/v1` JSONL artefact into the configured database (ADR-0013)',
  run: runImport,
};

export async function runImport(
  _deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<ImportSnapshotResult>> {
  const args = parseImportArgs(input.subargs);
  if (!args.ok) return args;

  let raw: string;
  try {
    raw = await readFile(args.value.in, 'utf8');
  } catch (cause) {
    return err({
      code: 'STORAGE_ERROR',
      message: `failed to read artefact at '${args.value.in}': ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  // Trailing newline (canonical) yields an empty final entry; drop it.
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const handle = openDatabase({ path: input.env.dbPath });
  try {
    const result = await importSnapshot({
      db: handle.db,
      source: lines,
      onConflict: args.value.onConflict,
      dryRun: args.value.dryRun,
    });
    if (!result.ok) return result;

    return ok({
      dbPath: input.env.dbPath,
      inPath: args.value.in,
      schemaVersion: result.value.schemaVersion,
      applied: result.value.applied,
      skipped: result.value.skipped,
      dryRun: result.value.dryRun,
    });
  } finally {
    handle.close();
  }
}

function parseImportArgs(subargs: readonly string[]): Result<ImportArgs> {
  let inPath: string | null = null;
  let dryRun = false;
  let onConflict: ImportConflictPolicy = 'skip';

  const args = [...subargs];
  while (args.length > 0) {
    const head = args[0] as string;
    if (head === '--dry-run') {
      dryRun = true;
      args.shift();
      continue;
    }
    if (head === '--in') {
      const value = args[1];
      if (value === undefined) {
        return err({ code: 'INVALID_INPUT', message: '--in requires a value' });
      }
      inPath = value;
      args.splice(0, 2);
      continue;
    }
    if (head.startsWith('--in=')) {
      inPath = head.slice('--in='.length);
      args.shift();
      continue;
    }
    if (head === '--on-conflict') {
      const value = args[1];
      if (value === undefined) {
        return err({ code: 'INVALID_INPUT', message: '--on-conflict requires a value' });
      }
      if (value !== 'skip' && value !== 'abort') {
        return err({
          code: 'INVALID_INPUT',
          message: `--on-conflict must be 'skip' or 'abort' (got '${value}')`,
        });
      }
      onConflict = value;
      args.splice(0, 2);
      continue;
    }
    if (head.startsWith('--on-conflict=')) {
      const value = head.slice('--on-conflict='.length);
      if (value !== 'skip' && value !== 'abort') {
        return err({
          code: 'INVALID_INPUT',
          message: `--on-conflict must be 'skip' or 'abort' (got '${value}')`,
        });
      }
      onConflict = value;
      args.shift();
      continue;
    }
    return err({ code: 'INVALID_INPUT', message: `unknown argument '${head}' for import` });
  }

  if (inPath === null) {
    return err({ code: 'INVALID_INPUT', message: '--in <path> is required' });
  }
  return ok({ in: inPath, dryRun, onConflict });
}
