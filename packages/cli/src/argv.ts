// Argv → typed `ParsedCommand`. The CLI's only argv-shaped surface.
//
// Why hand-rolled and not `commander`/`yargs`?
//
// Our grammar is small and stable:
//
//   memento [<global-flags>] <subcommand> [<subargs>]
//
//   subcommand:
//     --version | -V
//     --help    | -h
//     serve
//     context
//     store migrate
//     <namespace> <verb>          (e.g. memory write)
//     <namespace>.<verb>          (e.g. memory.write)
//
//   global flags (appear in any order before the first positional):
//     --db <path>                 env: MEMENTO_DB    default: XDG data dir
//     --format json|text|auto     env: MEMENTO_FORMAT default: auto
//     --debug                     opt into stack traces
//     --version, -V
//     --help, -h
//
// Session-scoped config overrides (the parsed-but-not-wired
// `--config k=v` that previously lived here) were removed: the
// engine accepts typed `ConfigOverrides`, but argv yields
// strings, so per-key Zod coercion plus threading into
// `createMementoApp` is real work that belongs in its own
// commit. Until then, persistent overrides go through
// `memento config set` (typed at the registry layer).
//
// A bespoke parser of ~150 lines is honest about what we accept,
// produces a typed ADT that downstream code can switch on
// exhaustively, and avoids dragging in a CLI framework with its
// own opinions about errors, help, and exit codes — concerns we
// already own elsewhere (`render.ts`, `exit-codes.ts`).
//
// `parseArgv` never reads the database, never builds a registry,
// never touches IO. It is a pure function: argv + env → ADT. This
// keeps `memento --version` cheap (no DB open) and makes every
// branch trivially testable.

import { resolveDefaultDbPath } from './db-path.js';

/**
 * Per-invocation environment resolved from argv + process env.
 * Subcommands consume this to wire up `createMementoApp` and
 * select an output format.
 */
export interface CliEnv {
  /**
   * Resolved DB path. Precedence:
   *   `--db` > `MEMENTO_DB` > XDG data dir (see `db-path.ts`).
   */
  readonly dbPath: string;
  /**
   * Output format. `auto` means the dispatcher resolves on TTY:
   * `text` if `io.isTTY`, otherwise `json`.
   */
  readonly format: 'json' | 'text' | 'auto';
  /** Opt-in stack traces for unhandled errors. */
  readonly debug: boolean;
}

/** Lifecycle commands — those that don't fit the registry's `AnyCommand` shape. */
export type LifecycleName =
  | 'serve'
  | 'context'
  | 'doctor'
  | 'store.migrate'
  | 'export'
  | 'import'
  | 'init'
  | 'status'
  | 'ping'
  | 'uninstall'
  | 'backup'
  | 'completions'
  | 'explain'
  | 'dashboard'
  | 'skill-path';

export type ParsedCommand =
  | { kind: 'version' }
  | { kind: 'help'; topic?: string }
  | {
      kind: 'lifecycle';
      name: LifecycleName;
      env: CliEnv;
      subargs: readonly string[];
    }
  | {
      kind: 'registry';
      commandName: string;
      env: CliEnv;
      subargs: readonly string[];
    }
  | { kind: 'parseError'; message: string };

export interface ParseArgvOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function parseArgv({ argv, env }: ParseArgvOptions): ParsedCommand {
  // Helper avoids the standoff between TypeScript's
  // `noPropertyAccessFromIndexSignature` (which forbids
  // `env.FOO`) and Biome's `useLiteralKeys` (which forbids
  // `env['FOO']`). A function call is allowed by both.
  const readEnv = (key: string): string | undefined => env[key];

  const envFormatRaw = readEnv('MEMENTO_FORMAT');
  const envFormat = parseFormat(envFormatRaw);
  if (envFormatRaw !== undefined && envFormat === undefined) {
    return {
      kind: 'parseError',
      message: `MEMENTO_FORMAT must be json|text|auto (got '${envFormatRaw}')`,
    };
  }

  const state = {
    dbPath: readEnv('MEMENTO_DB') ?? resolveDefaultDbPath({ env }),
    format: envFormat ?? ('auto' as const),
    debug: false,
    helpRequested: false,
    versionRequested: false,
  };

  const positionals: string[] = [];
  const args = [...argv];

  // Global flags are recognised anywhere in argv — both before
  // and after the subcommand. This matches the convention of npm,
  // git, kubectl, etc., and means
  //   memento --format text init
  //   memento init --format text
  // both work. Subcommand-specific flags (--quick, --client,
  // --input, …) don't collide with the small global set
  // (--db / --format / --debug / --help / --version) and pass
  // through into `positionals` for the per-command parser.
  //
  // Rejection of unknown global flags is gated on whether we have
  // already seen the subcommand: pre-subcommand `--foo` is a
  // hard error (no subcommand yet to interpret it); post-
  // subcommand `--foo` passes through and the subcommand parser
  // produces the more specific error.
  let sawSubcommand = false;

  while (args.length > 0) {
    const head = args[0] as string;

    if (head === '--' && !sawSubcommand) {
      // POSIX: pre-subcommand `--` ends global flag parsing.
      positionals.push(...args.slice(1));
      break;
    }

    if (head === '--help' || head === '-h') {
      state.helpRequested = true;
      args.shift();
      continue;
    }
    if (head === '--version' || head === '-V') {
      state.versionRequested = true;
      args.shift();
      continue;
    }
    if (head === '--debug') {
      state.debug = true;
      args.shift();
      continue;
    }

    const dbValue = takeFlagValue(args, '--db');
    if (dbValue !== undefined) {
      if (dbValue.error !== undefined) return { kind: 'parseError', message: dbValue.error };
      state.dbPath = dbValue.value;
      continue;
    }

    const formatValue = takeFlagValue(args, '--format');
    if (formatValue !== undefined) {
      if (formatValue.error !== undefined)
        return { kind: 'parseError', message: formatValue.error };
      const fmt = parseFormat(formatValue.value);
      if (fmt === undefined) {
        return {
          kind: 'parseError',
          message: `--format must be json|text|auto (got '${formatValue.value}')`,
        };
      }
      state.format = fmt;
      continue;
    }

    if (!sawSubcommand && head.startsWith('--')) {
      return { kind: 'parseError', message: `unknown flag '${head}'` };
    }

    // Positional or subcommand-specific flag — push and continue.
    positionals.push(head);
    args.shift();
    sawSubcommand = true;
  }

  if (state.versionRequested) return { kind: 'version' };
  if (positionals.length === 0) return { kind: 'help' };
  if (state.helpRequested) return { kind: 'help', topic: positionals.join(' ') };

  const cliEnv: CliEnv = {
    dbPath: state.dbPath,
    format: state.format,
    debug: state.debug,
  };

  const head = positionals[0] as string;

  if (head === 'serve') {
    return {
      kind: 'lifecycle',
      name: 'serve',
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (head === 'context') {
    return {
      kind: 'lifecycle',
      name: 'context',
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (head === 'doctor') {
    return {
      kind: 'lifecycle',
      name: 'doctor',
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (head === 'init') {
    return {
      kind: 'lifecycle',
      name: 'init',
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (
    head === 'status' ||
    head === 'ping' ||
    head === 'uninstall' ||
    head === 'backup' ||
    head === 'completions' ||
    head === 'explain' ||
    head === 'dashboard' ||
    head === 'skill-path'
  ) {
    return {
      kind: 'lifecycle',
      name: head,
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (head === 'export') {
    return {
      kind: 'lifecycle',
      name: 'export',
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (head === 'import') {
    return {
      kind: 'lifecycle',
      name: 'import',
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (head === 'store') {
    const verb = positionals[1];
    if (verb === 'migrate') {
      return {
        kind: 'lifecycle',
        name: 'store.migrate',
        env: cliEnv,
        subargs: positionals.slice(2),
      };
    }
    return {
      kind: 'parseError',
      message: `unknown subcommand 'store ${verb ?? ''}'`.trimEnd(),
    };
  }

  // Single-token sugar aliases for the most common registry
  // commands. Each aliases a `<namespace>.<verb>` registry path
  // with positional arguments mapped to the most ergonomic field
  // of that command's input schema. The mapping is intentionally
  // shallow — anything more structured falls through to the
  // explicit `--input <json>` form.
  //
  //   memento search <text>  → memento memory search --input '{"text":"…"}'
  //   memento list           → memento memory list
  //   memento read <id>      → memento memory read --input '{"id":"…"}'
  //   memento forget <id>    → memento memory forget --input '{"id":"…"}'
  //   memento get <key>      → memento config get --input '{"key":"…"}'
  const sugar = SUGAR_ALIASES[head];
  if (sugar !== undefined) {
    const expanded = sugar(positionals.slice(1));
    if (expanded === undefined) {
      return {
        kind: 'parseError',
        message: `'${head}' requires ${SUGAR_HINTS[head] ?? 'an argument'}`,
      };
    }
    return {
      kind: 'registry',
      commandName: expanded.commandName,
      env: cliEnv,
      subargs: expanded.subargs,
    };
  }

  // Registry: dotted single token, or `<ns> <verb>`.
  if (head.includes('.')) {
    return {
      kind: 'registry',
      commandName: head,
      env: cliEnv,
      subargs: positionals.slice(1),
    };
  }
  if (positionals.length >= 2) {
    return {
      kind: 'registry',
      commandName: `${head}.${positionals[1] as string}`,
      env: cliEnv,
      subargs: positionals.slice(2),
    };
  }
  return {
    kind: 'parseError',
    message: `unknown command '${head}' (expected '<namespace> <verb>' or '<namespace>.<verb>')`,
  };
}

/**
 * Consume `--name value` or `--name=value` from the head of `args`.
 *
 * Returns:
 *   - `undefined` — head is not the flag we asked for; caller continues.
 *   - `{ value }` — flag found and consumed; `args` mutated.
 *   - `{ error }` — flag found but value missing; caller surfaces.
 */
function takeFlagValue(
  args: string[],
  name: string,
): { value: string; error?: undefined } | { error: string; value?: undefined } | undefined {
  const head = args[0];
  if (head === undefined) return undefined;
  if (head === name) {
    const value = args[1];
    if (value === undefined) return { error: `${name} requires a value` };
    args.splice(0, 2);
    return { value };
  }
  const prefix = `${name}=`;
  if (head.startsWith(prefix)) {
    args.shift();
    return { value: head.slice(prefix.length) };
  }
  return undefined;
}

function parseFormat(value: string | undefined): 'json' | 'text' | 'auto' | undefined {
  if (value === 'json' || value === 'text' || value === 'auto') return value;
  return undefined;
}

/**
 * Single-token aliases that desugar into a registry call. Each
 * function returns the registry command name and the synthetic
 * subargs array (carrying a `--input` flag with JSON-encoded
 * positional arguments) or `undefined` when required positional
 * arguments are missing.
 */
const SUGAR_ALIASES: Record<
  string,
  (rest: readonly string[]) => { commandName: string; subargs: readonly string[] } | undefined
> = {
  search(rest) {
    if (rest.length === 0) return undefined;
    const text = rest.join(' ');
    return {
      commandName: 'memory.search',
      subargs: ['--input', JSON.stringify({ text })],
    };
  },
  list(_rest) {
    return {
      commandName: 'memory.list',
      subargs: [],
    };
  },
  read(rest) {
    if (rest.length === 0) return undefined;
    return {
      commandName: 'memory.read',
      subargs: ['--input', JSON.stringify({ id: rest[0] })],
    };
  },
  forget(rest) {
    if (rest.length === 0) return undefined;
    return {
      commandName: 'memory.forget',
      subargs: ['--input', JSON.stringify({ id: rest[0] })],
    };
  },
  get(rest) {
    if (rest.length === 0) return undefined;
    return {
      commandName: 'config.get',
      subargs: ['--input', JSON.stringify({ key: rest[0] })],
    };
  },
};

const SUGAR_HINTS: Record<string, string> = {
  search: 'a query string (e.g. `memento search "team conventions"`)',
  read: 'a memory id (e.g. `memento read mem_01H…`)',
  forget: 'a memory id (e.g. `memento forget mem_01H…`)',
  get: 'a config key (e.g. `memento get retrieval.vector.enabled`)',
};
