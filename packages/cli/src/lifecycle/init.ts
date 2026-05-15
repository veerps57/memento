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

import { existsSync } from 'node:fs';
import { constants, access, lstat, mkdir, unlink } from 'node:fs/promises';
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
import { resolveSkillSourceDir, suggestedSkillTargetDir } from '../skill-source.js';
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

/**
 * Optional skill bundle install info surfaced by `init` to
 * clients that load Anthropic-format skills.
 *
 * The renderer shows the skill section iff `capableClients` is
 * non-empty; on Cursor / VS Code Agent / OpenCode the section
 * is suppressed. `source` is `null` in dev environments where
 * the build did not stage the skill — the renderer falls back
 * to a docs link rather than printing a broken path.
 */
export interface SkillInstallInfo {
  /** IDs of capable clients in the rendered set. Empty → suppress. */
  readonly capableClients: readonly InitClientId[];
  /** Absolute path to the bundled skill source, or null when not bundled. */
  readonly source: string | null;
  /** Suggested target directory for the skill (display-only). */
  readonly suggestedTarget: string;
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
  /**
   * Optional skill bundle install info — see {@link SkillInstallInfo}.
   * Always populated; `capableClients` is empty when the
   * rendered client set has no Anthropic-skill-capable client,
   * which signals the renderer to suppress the skill section.
   */
  readonly skill: SkillInstallInfo;
}

// Keep in sync with `engines.node` in the workspace root
// `package.json` and the matching constants in `doctor.ts`.
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 11;

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

  // Order matters: `checkStaleWalSidecars` runs before
  // `checkDbPathWritable` (which mkdir's the parent dir) and
  // before `openAppForSurface` (which would otherwise hit the
  // SQLite WAL-recovery footgun and surface as a generic
  // 'disk I/O error'). The cleanup is observable via the
  // returned `InitCheck` so the user sees what happened on
  // their behalf — no silent surprises.
  const checks: InitCheck[] = [
    checkNodeVersion(),
    await checkStaleWalSidecars(input.env.dbPath),
    await checkDbPathWritable(input.env.dbPath),
  ];

  // Open + migrate. We shut down immediately — `init` does not
  // hold the DB beyond the success path. `shutdown` (not `close`)
  // so any in-flight startup backfill drains gracefully before
  // we release the database handle.
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  await opened.value.shutdown();

  const clients = renderClientSnippets(dbPath, {
    ...(clientFilter !== undefined ? { clients: clientFilter } : {}),
    ...(name !== undefined ? { name } : {}),
  });

  // Skill section is gated on the rendered set: only show it
  // when at least one capable client is present. We still
  // resolve the source even when capable is empty, because the
  // shape stays stable across snapshots.
  const capableClients = clients.filter((c) => c.supportsSkills).map((c) => c.id);
  const skill: SkillInstallInfo = {
    capableClients,
    source: resolveSkillSourceDir(),
    suggestedTarget: suggestedSkillTargetDir(),
  };

  return ok({
    version: resolveVersion(),
    dbPath,
    dbFromEnv,
    dbFromDefault,
    checks,
    clients,
    skill,
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

/**
 * Detect and clean up orphaned SQLite WAL/SHM/journal sidecar
 * files left behind when a user deletes the main `.db` file but
 * not its companions.
 *
 * Why this exists
 * ---------------
 *
 * Memento opens its database in WAL mode (`PRAGMA journal_mode =
 * WAL` in `applyPragmas`, `database.ts`). WAL mode produces three
 * files alongside the main `.db`:
 *
 *   memento.db        ← main file
 *   memento.db-wal    ← write-ahead log
 *   memento.db-shm    ← shared memory map
 *
 * (And, when the rare ROLLBACK journal mode kicks in mid-write,
 * `memento.db-journal`.) These sidecars are SQLite-owned: the
 * library creates them as a side effect of WAL mode and recovers
 * from them on next open.
 *
 * If a user deletes only `memento.db` (`rm memento.db`), the
 * sidecars survive. The next open creates a new empty `.db`,
 * sets WAL mode, and SQLite tries to recover from the orphan
 * WAL whose contents do not match the new (empty) main file.
 * The recovery fails and surfaces as a generic `disk I/O error`
 * — a misleading message that has bitten enough users that we
 * fix it at the Memento layer rather than expose them to the
 * SQLite footgun.
 *
 * What this function does
 * -----------------------
 *
 * The cleanup is sound only when the main `.db` is absent: that
 * is the unambiguous "no consistent state to recover" signal.
 * If the main file exists, the sidecars belong to SQLite and
 * we leave them alone — touching them then would corrupt active
 * databases.
 *
 * The function returns an `InitCheck` so the operation is
 * observable in the snapshot. A successful cleanup names what
 * was removed; a permission failure surfaces as a check
 * failure (the user must remove the sidecars by hand).
 */
async function checkStaleWalSidecars(dbPath: string): Promise<InitCheck> {
  if (dbPath === ':memory:') {
    return {
      name: 'stale-wal-sidecars',
      ok: true,
      message: 'in-memory database; no sidecar check',
    };
  }
  const absolute = path.resolve(dbPath);
  // If the main DB file exists, the sidecars (if any) belong
  // to SQLite — never touch them. The cleanup is only sound
  // when the main file is absent.
  if (existsSync(absolute)) {
    return {
      name: 'stale-wal-sidecars',
      ok: true,
      message: 'main db exists; sidecars (if any) are owned by SQLite',
    };
  }

  const removed: string[] = [];
  for (const suffix of ['-wal', '-shm', '-journal'] as const) {
    const orphan = `${absolute}${suffix}`;
    if (!existsSync(orphan)) continue;
    // Refuse to follow a symlink. An attacker who can place a
    // file at a predictable `${db}-wal` path on a shared host
    // could plant a symlink there before init runs and trick the
    // cleanup into deleting an unrelated file. `lstat` reports
    // on the link itself rather than the target; we only unlink
    // when the entry is a regular file.
    let stats: import('node:fs').Stats;
    try {
      stats = await lstat(orphan);
    } catch (cause) {
      return {
        name: 'stale-wal-sidecars',
        ok: false,
        message: `could not stat orphan sidecar '${orphan}': ${describe(cause)}. Remove it by hand and re-run.`,
      };
    }
    if (!stats.isFile()) {
      return {
        name: 'stale-wal-sidecars',
        ok: false,
        message: `orphan sidecar path '${orphan}' is not a regular file (symlink? directory?). Remove it by hand and re-run.`,
      };
    }
    try {
      await unlink(orphan);
      removed.push(path.basename(orphan));
    } catch (cause) {
      return {
        name: 'stale-wal-sidecars',
        ok: false,
        message: `could not remove orphan sidecar '${orphan}': ${describe(cause)}. Remove it by hand and re-run.`,
      };
    }
  }

  if (removed.length === 0) {
    return {
      name: 'stale-wal-sidecars',
      ok: true,
      message: 'no orphan WAL/SHM/journal sidecars present',
    };
  }
  return {
    name: 'stale-wal-sidecars',
    ok: true,
    message: `cleaned ${removed.length} orphan sidecar${removed.length === 1 ? '' : 's'} from a previous half-deleted store: ${removed.join(', ')}`,
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
    // Owner-only perms on the data directory. SQLite's
    // sidecar files (-wal, -shm) and the DB itself land here;
    // both carry operator-private memory content.
    await mkdir(dir, { recursive: true, mode: 0o700 });
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
