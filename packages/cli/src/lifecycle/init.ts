// `memento init` — onboarding command.
//
// Why this command exists
// -----------------------
//
// Without it, the post-install user journey is:
//
//   1. `npm i -g @psraghuveer/memento` (or run via npx).
//   2. Open `docs/guides/mcp-client-setup.md` in a browser.
//   3. Hand-copy a JSON snippet, manually edit the absolute
//      DB path, paste into their AI assistant's config file.
//   4. Cross fingers that the DB even exists; otherwise the
//      MCP client surfaces a cryptic spawn error from inside
//      its own log pane.
//
// `init` collapses that to one command: it ensures the
// database is created and migrated, then prints copy-paste
// snippets for every supported MCP client with the resolved
// DB path already filled in.
//
// What it does
// ------------
//
//   1. Open the database via `openAppForSurface`. This applies
//      pending migrations (idempotent) and surfaces any
//      storage / config error here, where the user can read
//      it — not later, buried in the AI assistant's logs.
//   2. Run a small subset of `doctor` checks (Node version,
//      DB-path writability) so onboarding catches obvious host
//      issues without forcing the user to chain a second
//      command.
//   3. Build the snippet bundle from the client registry
//      (`init-clients.ts`), filtered by `--client` and with
//      the server key swapped for `--name` if provided.
//   4. Return a structured `InitSnapshot`. The dispatcher
//      special-cases the text-format render path so a human on
//      a TTY gets a friendly walkthrough instead of pretty
//      JSON; pipes / scripts still get clean JSON they can
//      consume verbatim.
//
// Subargs
// -------
//
//   --client <id>[,<id>…]   Filter to one or more known clients.
//                            Valid ids: claude-code,
//                            claude-desktop, cursor, vscode,
//                            opencode.
//   --name <key>             Override the server key embedded
//                            in every snippet (default: `memento`).
//                            Useful when an existing config
//                            already has a `memento` entry that
//                            should not be overwritten.
//
// `init` is print-only: it never mutates the user's MCP client
// config files. A `--write` flag that merges into existing
// configs is a future enhancement; until it lands, the renderer
// surfaces this fact in its footer so the user is not left
// guessing.
//
// Failure modes
// -------------
//
//   - `openAppForSurface` failures (typically `STORAGE_ERROR`
//     for an unreachable DB path or `CONFIG_ERROR` if the
//     embedder peer dep is missing while
//     `retrieval.vector.enabled` is true) flow through the
//     standard error pipeline.
//   - `--client foo` with an unknown id surfaces as
//     `INVALID_INPUT` before the database is opened.

import { constants, access, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveDefaultDbPath } from '../db-path.js';
import {
  type ClientSnippet,
  INIT_CLIENT_IDS,
  type InitClientId,
  isInitClientId,
  renderClientSnippets,
} from '../init-clients.js';
import { resolveVersion } from '../version.js';
import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/**
 * One pre-flight check from `init`. Mirrors the shape of
 * `doctor`'s `DoctorCheck` so a future refactor can share the
 * type without breaking the on-the-wire snapshot.
 */
export interface InitCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

/** Stable contract for `memento init`. */
export interface InitSnapshot {
  readonly version: string;
  /** Resolved absolute DB path so snippets are portable. */
  readonly dbPath: string;
  /**
   * `true` when the resolved DB path came from the `MEMENTO_DB`
   * environment variable. When `false`, the path was derived
   * from the `--db` flag or the XDG default. Together with
   * `dbFromDefault` this is enough for the renderer to decide
   * whether the snippet's pinned path warrants a warning.
   */
  readonly dbFromEnv: boolean;
  /**
   * `true` when neither `--db` nor `MEMENTO_DB` was provided
   * and the path resolved to the XDG default for this host.
   * Stable across cwds and shells, so the renderer suppresses
   * its "this might drift" warning in this case.
   */
  readonly dbFromDefault: boolean;
  /**
   * Pre-flight checks run during onboarding. Always present;
   * an empty array means no checks were registered (today every
   * call returns at least `node-version` and `db-path-writable`).
   */
  readonly checks: readonly InitCheck[];
  readonly clients: readonly ClientSnippet[];
}

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 10;

export const initCommand: LifecycleCommand = {
  name: 'init',
  description: 'Initialise the database and print MCP client setup snippets',
  run: runInit,
};

export async function runInit(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<InitSnapshot>> {
  const parsed = parseSubargs(input.subargs);
  if (!parsed.ok) return parsed;
  const { clients: clientFilter, name } = parsed.value;

  const dbPath = resolveDbPathForSnippet(input.env.dbPath);
  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
  const dbFromEnv = input.io.env['MEMENTO_DB'] !== undefined;
  // The resolved env.dbPath equals the XDG default iff the
  // user supplied neither --db nor MEMENTO_DB. We recompute
  // here rather than threading a source tag through argv so
  // the parser stays a pure function of (argv, env).
  const dbFromDefault =
    !dbFromEnv && input.env.dbPath === resolveDefaultDbPath({ env: input.io.env });

  const checks: InitCheck[] = [checkNodeVersion(), await checkDbPathWritable(input.env.dbPath)];

  // Open + migrate. We close immediately — `init` does not
  // hold the DB beyond the success path.
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  opened.value.close();

  return ok({
    version: resolveVersion(),
    dbPath,
    dbFromEnv,
    dbFromDefault,
    checks,
    clients: renderClientSnippets(dbPath, {
      ...(clientFilter !== undefined ? { clients: clientFilter } : {}),
      ...(name !== undefined ? { name } : {}),
    }),
  });
}

interface InitSubargs {
  readonly clients?: readonly InitClientId[];
  readonly name?: string;
}

function parseSubargs(subargs: readonly string[]): Result<InitSubargs> {
  let clients: readonly InitClientId[] | undefined;
  let name: string | undefined;
  for (let i = 0; i < subargs.length; i += 1) {
    const arg = subargs[i] as string;
    const [flag, inlineValue] = splitFlag(arg);
    if (flag === '--client') {
      const value = inlineValue ?? subargs[++i];
      if (value === undefined) {
        return err({ code: 'INVALID_INPUT', message: '--client requires a value' });
      }
      const parsed = parseClientList(value);
      if (!parsed.ok) return parsed;
      clients = parsed.value;
      continue;
    }
    if (flag === '--name') {
      const value = inlineValue ?? subargs[++i];
      if (value === undefined || value.length === 0) {
        return err({ code: 'INVALID_INPUT', message: '--name requires a non-empty value' });
      }
      name = value;
      continue;
    }
    return err({
      code: 'INVALID_INPUT',
      message: `unknown argument '${arg}' for 'init' (accepted: --client <id[,id…]>, --name <key>)`,
    });
  }
  return ok({
    ...(clients !== undefined ? { clients } : {}),
    ...(name !== undefined ? { name } : {}),
  });
}

function splitFlag(arg: string): readonly [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq > 0) {
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}

function parseClientList(value: string): Result<readonly InitClientId[]> {
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = ids.filter((id) => !isInitClientId(id));
  if (unknown.length > 0) {
    return err({
      code: 'INVALID_INPUT',
      message: `unknown client id(s): ${unknown.join(', ')} (valid: ${INIT_CLIENT_IDS.join(', ')})`,
    });
  }
  return ok(ids as readonly InitClientId[]);
}

function checkNodeVersion(): InitCheck {
  const raw = process.versions.node;
  const [majorRaw, minorRaw] = raw.split('.');
  const major = majorRaw === undefined ? Number.NaN : Number.parseInt(majorRaw, 10);
  const minor = minorRaw === undefined ? Number.NaN : Number.parseInt(minorRaw, 10);
  const compliant =
    Number.isFinite(major) &&
    Number.isFinite(minor) &&
    (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR));
  return {
    name: 'node-version',
    ok: compliant,
    message: compliant
      ? `Node ${raw} satisfies >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`
      : `Node ${raw} is below required >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`,
  };
}

async function checkDbPathWritable(dbPath: string): Promise<InitCheck> {
  if (dbPath === ':memory:') {
    return {
      name: 'db-path-writable',
      ok: true,
      message: 'in-memory database; no filesystem check',
    };
  }
  const dir = path.dirname(path.resolve(dbPath));
  // `init` is the lifecycle point where creating the data
  // directory is expected and visible — `db-path.ts` defaults
  // to platform-standard locations (XDG / %LOCALAPPDATA%) that
  // exist on most hosts but are not guaranteed on a fresh
  // user account. Without this `mkdir -p`, the first run on a
  // brand-new laptop fails the writability check below before
  // `openAppForSurface` can create the DB file.
  //
  // Idempotent (`recursive: true`), and any failure (permission
  // denied on a parent component, EACCES, etc.) falls through
  // to the access() probe so the user sees a single,
  // descriptive `not writable` message rather than two.
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Intentionally swallowed — surfaced via the access() probe.
  }
  try {
    await access(dir, constants.W_OK);
    return {
      name: 'db-path-writable',
      ok: true,
      message: `parent directory '${dir}' is writable`,
    };
  } catch (cause) {
    return {
      name: 'db-path-writable',
      ok: false,
      message: `parent directory '${dir}' is not writable: ${describe(cause)}`,
    };
  }
}

/**
 * Resolve the DB path to an absolute form for the snippet.
 *
 * `:memory:` is a SQLite pseudo-path; embedding it in an MCP
 * config would be misleading because every spawn would get a
 * fresh, empty in-memory DB. Pass it through verbatim and let
 * the renderer surface a warning.
 *
 * Anything else is resolved against the current working
 * directory so the snippet works no matter where the user
 * invokes their MCP client from.
 */
export function resolveDbPathForSnippet(dbPath: string): string {
  if (dbPath === ':memory:') return dbPath;
  return path.resolve(dbPath);
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
