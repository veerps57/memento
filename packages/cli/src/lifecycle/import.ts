// `memento import` lifecycle command.
//
// Reads a `memento-export/v1` JSONL artefact from disk and applies
// it to the configured database in a single transaction. The
// engine-level mechanics — header schema, SHA-256 footer, conflict
// policy, transactional apply, the ADR-0019 re-stamp policy — live
// in `@psraghuveer/memento-core`'s `importSnapshot`; this module
// owns the argv parsing, the streaming source, and the
// CLI-shaped summary.
//
// Argv grammar:
//
//   memento import --in <path> [--dry-run]
//                  [--on-conflict skip|abort]
//                  [--trust-source]
//
// `--dry-run` parses + validates the artefact (including the
// SHA-256 check) but never opens a write transaction.
//
// `--on-conflict` defaults to `skip` — the most common case is
// "merge an artefact from another machine into mine and keep my
// local additions". `abort` is for the strict "must be empty
// target or fail" case.
//
// `--trust-source` opts into preserving the source artefact's
// `MemoryEvent` audit chain. The default (collapse mode) replaces
// it with one synthetic `memory.imported` event per memory, so
// the importer's audit log honestly reports when memories
// arrived. Either way, `OwnerRef` is rewritten to local-self and
// content is re-scrubbed with the importer's current rule set —
// those are non-negotiable. See ADR-0019.
//
// Streaming. The artefact is read line-by-line via
// `readline.createInterface` over `createReadStream` so a
// multi-gigabyte file does not OOM the CLI before parsing
// begins. An upfront `fs.stat` rejects files larger than
// `import.maxBytes` (default 256 MiB).
//
// Note: this command does NOT auto-migrate the destination DB.
// Operators are expected to run `memento store migrate` first;
// the header's `schemaVersion <= MEMORY_SCHEMA_VERSION`
// handshake guards against importing an artefact authored
// against a *newer* engine.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import {
  type ImportConflictPolicy,
  type ImportSummary,
  embedAndStore,
  importSnapshot,
} from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';

import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Operator-facing payload of `memento import`. */
export interface ImportSnapshotResult {
  readonly dbPath: string;
  readonly inPath: string;
  readonly schemaVersion: number;
  readonly applied: ImportSummary['applied'];
  readonly skipped: ImportSummary['skipped'];
  readonly dryRun: boolean;
  readonly trustSource: boolean;
}

interface ImportArgs {
  readonly in: string;
  readonly dryRun: boolean;
  readonly onConflict: ImportConflictPolicy;
  readonly trustSource: boolean;
}

export const importCommand: LifecycleCommand = {
  name: 'import',
  description:
    'Import a `memento-export/v1` JSONL artefact into the configured database (ADR-0013, ADR-0019)',
  run: runImport,
};

export async function runImport(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<ImportSnapshotResult>> {
  const args = parseImportArgs(input.subargs);
  if (!args.ok) return args;

  // Use openAppForSurface so the import lifecycle gets a wired
  // embedder when `retrieval.vector.enabled` is true. Without
  // this, post-commit batch-embed (ADR-0021) would silently
  // skip — the same gap we close for `pack.install`.
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  const app = opened.value;

  try {
    const maxBytes = app.configStore.get('import.maxBytes');
    let fileSize: number;
    try {
      const stats = await stat(args.value.in);
      fileSize = stats.size;
    } catch (cause) {
      return err({
        code: 'STORAGE_ERROR',
        message: `failed to read artefact at '${args.value.in}': ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    if (fileSize > maxBytes) {
      return err({
        code: 'INVALID_INPUT',
        message: `artefact at '${args.value.in}' is ${fileSize} bytes; exceeds import.maxBytes (${maxBytes}). Raise the limit with \`memento config set import.maxBytes <bytes>\` or split the artefact.`,
        details: { size: fileSize, limit: maxBytes },
      });
    }

    // Construct a synchronous batch-embed callback. Skipped
    // (passed as undefined) when `retrieval.vector.enabled` is
    // false — `openAppForSurface` only wires `embeddingProvider`
    // in that case.
    const provider = app.embeddingProvider;
    const result = await importSnapshot({
      db: app.db.db,
      source: streamLines(args.value.in),
      onConflict: args.value.onConflict,
      dryRun: args.value.dryRun,
      trustSource: args.value.trustSource,
      scrubber: {
        rules: app.configStore.get('scrubber.rules'),
        enabled: app.configStore.get('scrubber.enabled'),
        engineBudgetMs: app.configStore.get('scrubber.engineBudgetMs'),
      },
      actor: { type: 'cli' },
      ...(provider !== undefined && app.configStore.get('embedding.autoEmbed')
        ? {
            embedAndStore: async (memories, actor) => {
              await embedAndStore(memories, provider, app.memoryRepository, actor);
            },
          }
        : {}),
    });
    if (!result.ok) return result;

    return ok({
      dbPath: input.env.dbPath,
      inPath: args.value.in,
      schemaVersion: result.value.schemaVersion,
      applied: result.value.applied,
      skipped: result.value.skipped,
      dryRun: result.value.dryRun,
      trustSource: args.value.trustSource,
    });
  } finally {
    await app.shutdown();
  }
}

/**
 * Async generator wrapping `readline.createInterface` over a file
 * stream. Yields one line at a time, never buffering the whole
 * artefact in memory. The trailing newline (canonical) yields a
 * final empty line that the engine's parser already drops via
 * the bodyLines slice; we don't filter here so the engine sees
 * exactly the bytes the file contains.
 */
async function* streamLines(path: string): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function parseImportArgs(subargs: readonly string[]): Result<ImportArgs> {
  let inPath: string | null = null;
  let dryRun = false;
  let trustSource = false;
  let onConflict: ImportConflictPolicy = 'skip';

  const args = [...subargs];
  while (args.length > 0) {
    const head = args[0] as string;
    if (head === '--dry-run') {
      dryRun = true;
      args.shift();
      continue;
    }
    if (head === '--trust-source') {
      trustSource = true;
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
  return ok({ in: inPath, dryRun, onConflict, trustSource });
}
