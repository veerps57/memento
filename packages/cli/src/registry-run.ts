// Generic projection of registry commands onto the CLI.
//
// The lifecycle commands (#26.2 / #26.3 / #26.4) live in their
// own files because they don't fit `AnyCommand`'s shape. Every
// other registered command — `memory.write`, `memory.search`,
// `conflict.resolve`, etc. — flows through here.
//
// Composition mirrors `runServe`:
//
//   1. `deps.createApp({ dbPath })` opens the
//      DB, runs migrations, builds the registry.
//   2. `buildCliAdapter({ registry, ctx })` filters to commands
//      whose `surfaces` includes `'cli'`. The adapter is the
//      single typed entry point the CLI uses to invoke registry
//      commands; it holds no IO of its own.
//   3. `readRegistryInput(parsed.subargs, io)` resolves the
//      `--input` flag into a JSON string. The supported forms
//      mirror the help text:
//        - `--input <json>` literal JSON
//        - `--input @path`  read the file at `path`
//        - `--input -`      read stdin until EOF
//        - (absent)         empty object `{}`
//   4. The adapter's `run` calls `executeCommand`, which validates
//      via Zod. Validation failures become `INVALID_INPUT` and
//      flow through the standard render pipeline.
//   5. `app.shutdown()` runs in a `finally` so the SQLite handle is
//      released even if rendering or execution throws.
//
// Why empty-object as the default: most read-side commands have
// schemas with all-optional fields (e.g. `memory.list` with
// optional cursor/limit). Defaulting to `{}` means scripts can
// say `memento memory list` without `--input '{}'` boilerplate.
// Commands whose required fields are missing fail with a
// crisp `INVALID_INPUT` from the existing pipeline.
//
// Actor identity for CLI dispatch is `{ type: 'cli' }` per
// `ActorRefSchema`. The MCP surface uses `{ type: 'mcp', agent }`
// (see `runServe`); choosing the right actor for the surface is
// the only piece of context plumbing this module owns.

import type { CommandContext } from '@psraghuveer/memento-core';
import { type Result, err } from '@psraghuveer/memento-schema';

import type { CliEnv } from './argv.js';
import { buildCliAdapter } from './build-adapter.js';
import type { CliIO } from './io.js';
import { openAppForSurface } from './lifecycle/index.js';
import type { LifecycleDeps } from './lifecycle/index.js';
import { resolveVersion } from './version.js';

/**
 * Inputs to `runRegistry`. Mirrors `LifecycleInput` but typed
 * narrower because registry commands don't take subargs beyond
 * the `--input` flag handled here.
 */
export interface RegistryInput {
  readonly env: CliEnv;
  readonly subargs: readonly string[];
  readonly io: CliIO;
  readonly commandName: string;
}

export async function runRegistry(
  deps: LifecycleDeps,
  input: RegistryInput,
): Promise<Result<unknown>> {
  // Resolve the input source first — this is pure (modulo the
  // file/stdin read) and surfaces argument errors before we
  // bother opening the database.
  const inputResult = await readRegistryInput(input.subargs, input.io);
  if (!inputResult.ok) return inputResult;
  const rawInput = inputResult.value;

  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  const app = opened.value;

  try {
    const ctx: CommandContext = { actor: { type: 'cli' } };
    const adapter = buildCliAdapter({ registry: app.registry, ctx });
    return await adapter.run(input.commandName, rawInput);
  } finally {
    await app.shutdown();
  }
}

/**
 * Resolve the `--input` flag from a registry command's subargs
 * to a parsed JSON value. Returns the empty object when no
 * `--input` is present (most read commands have all-optional
 * fields; this keeps `memento memory list` ergonomic).
 *
 * The three supported forms mirror the help text:
 *   - `--input <json>` literal JSON
 *   - `--input @path`  read the file at `path`
 *   - `--input -`      read stdin until EOF
 *
 * Unrecognised subargs produce a crisp `INVALID_INPUT` so users
 * see argument typos without first incurring a database open.
 */
export async function readRegistryInput(
  subargs: readonly string[],
  io: CliIO,
): Promise<Result<unknown>> {
  let inputSpec: string | undefined;
  for (let i = 0; i < subargs.length; i += 1) {
    const arg = subargs[i] as string;
    if (arg === '--input') {
      const next = subargs[i + 1];
      if (next === undefined) {
        return err({
          code: 'INVALID_INPUT',
          message: '--input requires a value',
        });
      }
      if (inputSpec !== undefined) {
        return err({
          code: 'INVALID_INPUT',
          message: '--input may only appear once',
        });
      }
      inputSpec = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--input=')) {
      if (inputSpec !== undefined) {
        return err({
          code: 'INVALID_INPUT',
          message: '--input may only appear once',
        });
      }
      inputSpec = arg.slice('--input='.length);
      continue;
    }
    return err({
      code: 'INVALID_INPUT',
      message: `unknown argument '${arg}' (registry commands accept only --input)`,
    });
  }

  if (inputSpec === undefined) {
    return { ok: true, value: {} };
  }

  let raw: string;
  try {
    if (inputSpec === '-') {
      raw = await readAll(io.stdin);
    } else if (inputSpec.startsWith('@')) {
      const { readFile } = await import('node:fs/promises');
      raw = await readFile(inputSpec.slice(1), 'utf8');
    } else {
      raw = inputSpec;
    }
  } catch (cause) {
    return err({
      code: 'INVALID_INPUT',
      message: `failed to read --input: ${describe(cause)}`,
    });
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (cause) {
    return err({
      code: 'INVALID_INPUT',
      message: `--input is not valid JSON: ${describe(cause)}`,
      hint: 'Wrap the value in single quotes so the shell does not strip the JSON quotes (e.g. --input \u0027{"k":"v"}\u0027), or pass @path/to/file.json.',
    });
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
