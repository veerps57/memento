// `memento export` lifecycle command.
//
// Streams a `memento-export/v1` JSONL artefact from the configured
// database to a destination path (or stdout when `--out` is
// omitted). Wraps `exportSnapshot` from `@psraghuveer/memento-core`; this
// module owns the argv parsing and the file/stdout sink.
//
// Why a lifecycle command and not a registry command:
//
//   - It owns its IO sink (a filesystem path or stdout stream),
//     which the registry's `(input, ctx) -> Result<output>` shape
//     does not model.
//   - It runs against a read-only handle, intentionally bypassing
//     the engine's write path so it cannot mutate state.
//   - Its output is the artefact itself (bytes), not a registry
//     payload; the structured `Result` carries the summary only.
//
// Argv grammar:
//
//   memento export [--out <path>] [--include-embeddings] [--scope <selector>]
//
// `--out` defaults to the value of `export.defaultPath` config
// (which itself defaults to `null` ⇒ stdout). `--include-embeddings`
// defaults to the `export.includeEmbeddings` config value. `--scope`
// is parsed but currently ignored — full scope projection is part
// of a follow-up (P1.4 baseline ships full-DB exports).

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type ExportSummary, exportSnapshot } from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';

import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/**
 * Operator-facing payload of `memento export`. Mirrors the
 * engine's `ExportSummary` plus the resolved output path.
 */
export interface ExportSnapshot {
  readonly dbPath: string;
  readonly outPath: string | null;
  readonly format: ExportSummary['format'];
  readonly schemaVersion: number;
  readonly counts: ExportSummary['counts'];
  readonly sha256: string;
}

interface ExportArgs {
  readonly out: string | null;
  readonly includeEmbeddings: boolean;
  readonly overwrite: boolean;
}

export const exportCommand: LifecycleCommand = {
  name: 'export',
  description:
    'Export the configured database to a portable `memento-export/v1` JSONL artefact (ADR-0013)',
  run: runExport,
};

export async function runExport(
  _deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<ExportSnapshot>> {
  const args = parseExportArgs(input.subargs);
  if (!args.ok) return args;

  // Confirm the source DB exists before opening — `openDatabase`
  // would otherwise create a fresh empty file on a typo.
  try {
    await stat(input.env.dbPath);
  } catch {
    return err({
      code: 'STORAGE_ERROR',
      message: `database not found at '${input.env.dbPath}'`,
    });
  }

  const writer = await openWriter(args.value.out, args.value.overwrite, input);
  if (!writer.ok) return writer;

  try {
    const summary = await exportSnapshot({
      dbPath: input.env.dbPath,
      writer: writer.value.writer,
      includeEmbeddings: args.value.includeEmbeddings,
      mementoVersion: resolveVersion(),
    });
    await writer.value.close();
    return ok({
      dbPath: input.env.dbPath,
      outPath: args.value.out,
      format: summary.format,
      schemaVersion: summary.schemaVersion,
      counts: summary.counts,
      sha256: summary.sha256,
    });
  } catch (cause) {
    await writer.value.close().catch(() => undefined);
    return err({
      code: 'STORAGE_ERROR',
      message: `export failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

function parseExportArgs(subargs: readonly string[]): Result<ExportArgs> {
  let out: string | null = null;
  let includeEmbeddings = false;
  let overwrite = false;

  const args = [...subargs];
  while (args.length > 0) {
    const head = args[0] as string;
    if (head === '--include-embeddings') {
      includeEmbeddings = true;
      args.shift();
      continue;
    }
    if (head === '--overwrite') {
      overwrite = true;
      args.shift();
      continue;
    }
    if (head === '--out') {
      const value = args[1];
      if (value === undefined) {
        return err({ code: 'INVALID_INPUT', message: '--out requires a value' });
      }
      out = value;
      args.splice(0, 2);
      continue;
    }
    if (head.startsWith('--out=')) {
      out = head.slice('--out='.length);
      args.shift();
      continue;
    }
    if (head === '--scope') {
      // Parsed but discarded — see module header.
      if (args[1] === undefined) {
        return err({ code: 'INVALID_INPUT', message: '--scope requires a value' });
      }
      args.splice(0, 2);
      continue;
    }
    if (head.startsWith('--scope=')) {
      args.shift();
      continue;
    }
    return err({ code: 'INVALID_INPUT', message: `unknown argument '${head}' for export` });
  }

  return ok({ out, includeEmbeddings, overwrite });
}

interface OpenedWriter {
  readonly writer: { write(line: string): Promise<void> };
  readonly close: () => Promise<void>;
}

async function openWriter(
  out: string | null,
  overwrite: boolean,
  input: LifecycleInput,
): Promise<Result<OpenedWriter>> {
  if (out === null) {
    // stdout sink — adopt the CLI's stdout. We cannot return a
    // close handle that flushes process.stdout, so close() is a
    // no-op; the runtime drains stdout on exit.
    const stdout = input.io.stdout;
    return ok({
      writer: {
        write: async (line: string): Promise<void> => {
          stdout.write(line);
        },
      },
      close: async () => undefined,
    });
  }

  try {
    await mkdir(dirname(out), { recursive: true });
  } catch (cause) {
    return err({
      code: 'STORAGE_ERROR',
      message: `failed to create output directory: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  // Refuse to overwrite by default. The export contains memory
  // content (post-scrub but still operator-private) and a
  // hand-typed `--out path/to/old-export.jsonl` should not
  // silently replace a backup the operator forgot about. The
  // explicit `--overwrite` flag opts in. `mode: 0o600` makes the
  // file user-private even on hosts with permissive umasks —
  // memory content is operator data.
  const stream = createWriteStream(out, {
    encoding: 'utf8',
    flags: overwrite ? 'w' : 'wx',
    mode: 0o600,
  });
  // Wait for the open to settle so an `EEXIST` becomes a typed
  // error rather than a stream-level emit later.
  const opened = await new Promise<Error | null>((resolve) => {
    stream.once('open', () => resolve(null));
    stream.once('error', (e) => resolve(e));
  });
  if (opened !== null) {
    const cause = opened as NodeJS.ErrnoException;
    if (cause.code === 'EEXIST') {
      return err({
        code: 'INVALID_INPUT',
        message: `refusing to overwrite existing file at '${out}' — pass --overwrite to replace it`,
      });
    }
    return err({
      code: 'STORAGE_ERROR',
      message: `failed to open output file: ${cause.message}`,
    });
  }
  return ok({
    writer: {
      write: (line: string): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          stream.write(line, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        stream.end((error: Error | null | undefined) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  });
}
