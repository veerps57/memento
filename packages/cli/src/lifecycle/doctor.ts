// `memento doctor` — diagnostic checks for a fresh install.
//
// Purpose: when something is wrong, this is the first command a
// new operator (or a bug report) should run. Each check runs in
// isolation and reports its own outcome; one bad check never
// aborts the rest. The output shape is stable JSON so a report
// can be pasted verbatim into an issue tracker.
//
// Checks (in declared order):
//
//   1. node-version       — runtime ≥ 20.10 (matches `engines`).
//   2. db-path-writable   — parent directory of `--db` exists
//                            and is writable. Skipped for the
//                            `:memory:` pseudo-path.
//   3. native-binding     — better-sqlite3's compiled binding
//                            loads under the current Node ABI.
//                            The most common postinstall failure
//                            (NODE_MODULE_VERSION mismatch when
//                            switching Node versions) is detected
//                            here with a rebuild hint, before the
//                            opaque `database` failure below.
//   4. database           — `createMementoApp` opens the DB and
//                            applies migrations.
//   5. embedder           — if `retrieval.vector.enabled` is
//                            true, `@psraghuveer/memento-embedder-local`
//                            (peer dependency) can be imported.
//
// Exit-code mapping: any DB-related failure surfaces as
// `STORAGE_ERROR`; any other failure as `CONFIG_ERROR`. On
// success the command returns `ok({ ok: true, checks })`.

import { existsSync, readFileSync } from 'node:fs';
import { constants, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type { MementoApp } from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

const requireFromHere = createRequire(import.meta.url);

/** One diagnostic check result. Stable contract. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  /**
   * Optional one-sentence remediation surfaced on the error
   * envelope's `hint` field when the check fails. Additive:
   * older consumers that only render `message` keep working.
   */
  readonly hint?: string;
}

/** Output shape for `memento doctor`. Stable contract. */
export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 10;

export const doctorCommand: LifecycleCommand = {
  name: 'doctor',
  description: 'Run diagnostic checks (Node version, database access, optional dependencies)',
  run: runDoctor,
};

export async function runDoctor(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<DoctorReport>> {
  const flags = parseDoctorFlags(input.subargs);
  if (!flags.ok) return flags;
  const { quick, mcp } = flags.value;

  const checks: DoctorCheck[] = [];

  checks.push(checkNodeVersion());

  const dbPath = input.env.dbPath;
  checks.push(await checkDbPathWritable(dbPath));

  const bindingCheck = checkNativeBinding();
  checks.push(bindingCheck);

  // `--quick` skips the more expensive checks (DB open, embedder
  // resolution, MCP scan) and is useful as a CI smoke-test gate
  // or a pre-commit hook. The cheap host checks above always run.
  if (quick) {
    return finaliseDoctor(checks);
  }

  // If the binding itself failed to load there is no point asking
  // `createMementoApp` to open the database — it would just throw
  // the same error wrapped in a less specific message. Skip the
  // database check so the doctor report points at the real cause.
  if (!bindingCheck.ok) {
    return finaliseDoctor(checks);
  }

  const dbCheck = await checkDatabase(deps, dbPath);
  checks.push(dbCheck.check);

  if (dbCheck.app !== undefined) {
    try {
      checks.push(await checkEmbedder(dbCheck.app));
    } finally {
      dbCheck.app.close();
    }
  }

  if (mcp) {
    checks.push(...checkMcpClients());
  }

  return finaliseDoctor(checks);
}

function finaliseDoctor(checks: readonly DoctorCheck[]): Result<DoctorReport> {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    return ok({ ok: true, checks });
  }
  const dbFailed = failed.some(
    (c) => c.name === 'database' || c.name === 'db-path-writable' || c.name === 'native-binding',
  );
  // Prefer the first failing check that carries a hint; this
  // keeps the envelope hint surface small and predictable while
  // still giving the operator a concrete next step when one is
  // available (e.g. native-binding rebuild).
  const firstHint = failed.find((c) => c.hint !== undefined)?.hint;
  return err({
    code: dbFailed ? 'STORAGE_ERROR' : 'CONFIG_ERROR',
    message: `${failed.length} doctor check(s) failed: ${failed.map((c) => c.name).join(', ')}`,
    details: { ok: false, checks } satisfies DoctorReport,
    ...(firstHint !== undefined ? { hint: firstHint } : {}),
  });
}

interface DoctorFlags {
  readonly quick: boolean;
  readonly mcp: boolean;
}

function parseDoctorFlags(subargs: readonly string[]): Result<DoctorFlags> {
  let quick = false;
  let mcp = false;
  for (const arg of subargs) {
    if (arg === '--quick') {
      quick = true;
      continue;
    }
    if (arg === '--mcp') {
      mcp = true;
      continue;
    }
    return err({
      code: 'INVALID_INPUT',
      message: `unknown argument '${arg}' for 'doctor' (accepted: --quick, --mcp)`,
    });
  }
  return ok({ quick, mcp });
}

function checkNodeVersion(): DoctorCheck {
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

async function checkDbPathWritable(dbPath: string): Promise<DoctorCheck> {
  // `:memory:` is the SQLite pseudo-path used by tests and the
  // `--db :memory:` smoke flow. It never touches the filesystem.
  if (dbPath === ':memory:') {
    return {
      name: 'db-path-writable',
      ok: true,
      message: 'in-memory database; no filesystem check',
    };
  }
  const dir = path.dirname(path.resolve(dbPath));
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

function checkNativeBinding(): DoctorCheck {
  // Imported synchronously through `createRequire` so the
  // failure mode mirrors what `createApp` would hit a moment
  // later — a NODE_MODULE_VERSION mismatch surfaces here as
  // ERR_DLOPEN_FAILED from the same prebuild resolution path.
  // Catching it here lets us return a structured rebuild hint
  // instead of letting `database` swallow it into a generic
  // STORAGE_ERROR.
  try {
    const Database = requireFromHere('better-sqlite3') as new (p: string) => { close(): void };
    const probe = new Database(':memory:');
    probe.close();
    return {
      name: 'native-binding',
      ok: true,
      message: `better-sqlite3 native binding loaded for Node ${process.versions.node} (modules ABI ${process.versions.modules})`,
    };
  } catch (cause) {
    const message = describe(cause);
    const looksLikeAbi =
      /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node/i.test(message);
    return {
      name: 'native-binding',
      ok: false,
      message: `better-sqlite3 native binding failed to load (Node ${process.versions.node}, modules ABI ${process.versions.modules}): ${message}`,
      hint: looksLikeAbi
        ? 'Run: npm rebuild better-sqlite3 --build-from-source (or reinstall after switching Node versions)'
        : 'Reinstall the memento package; if the failure persists, run with --debug and file an issue.',
    };
  }
}

async function checkDatabase(
  deps: LifecycleDeps,
  dbPath: string,
): Promise<{ check: DoctorCheck; app?: MementoApp }> {
  try {
    const app = await deps.createApp({ dbPath });
    return {
      check: {
        name: 'database',
        ok: true,
        message: `opened database at '${dbPath}' and applied migrations`,
      },
      app,
    };
  } catch (cause) {
    return {
      check: {
        name: 'database',
        ok: false,
        message: `failed to open database at '${dbPath}': ${describe(cause)}`,
      },
    };
  }
}

async function checkEmbedder(app: MementoApp): Promise<DoctorCheck> {
  const enabled = app.configStore.get('retrieval.vector.enabled');
  if (enabled !== true) {
    return {
      name: 'embedder',
      ok: true,
      message: 'retrieval.vector.enabled is false; embedder peer dep not required',
    };
  }
  try {
    // Resolve only — we don't need to load the module here, just
    // confirm the host environment can find it. `createRequire`
    // bypasses TypeScript's static module resolution so the CLI
    // package itself isn't forced to declare a dependency on the
    // optional embedder package.
    requireFromHere.resolve('@psraghuveer/memento-embedder-local');
    return {
      name: 'embedder',
      ok: true,
      message: 'retrieval.vector.enabled is true; @psraghuveer/memento-embedder-local resolved',
    };
  } catch (cause) {
    return {
      name: 'embedder',
      ok: false,
      message: `retrieval.vector.enabled is true but @psraghuveer/memento-embedder-local cannot be resolved: ${describe(cause)}`,
    };
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Best-effort scan of well-known MCP client config paths for
 * a `memento` entry. We don't enforce a particular shape — the
 * point is to tell the user "yes, your assistant is configured
 * to launch this binary" before they go hunting.
 *
 * Each candidate path is opened best-effort: missing files
 * surface as a passing `not-installed` check rather than a
 * failure, because not configuring every supported client is
 * the common case (most users only wire one or two).
 */
function checkMcpClients(): readonly DoctorCheck[] {
  const home = os.homedir();
  const candidates: ReadonlyArray<{ name: string; path: string; key: string }> = [
    { name: 'mcp-claude-code-user', path: path.join(home, '.claude.json'), key: 'mcpServers' },
    { name: 'mcp-claude-code-project', path: path.resolve('.mcp.json'), key: 'mcpServers' },
    {
      name: 'mcp-claude-desktop-macos',
      path: path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
      key: 'mcpServers',
    },
    { name: 'mcp-cursor', path: path.join(home, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { name: 'mcp-vscode-workspace', path: path.resolve('.vscode', 'mcp.json'), key: 'servers' },
    {
      name: 'mcp-opencode',
      path: path.join(home, '.config', 'opencode', 'opencode.json'),
      key: 'mcp',
    },
  ];
  return candidates.map(({ name, path: configPath, key }) => {
    if (!existsSync(configPath)) {
      return {
        name,
        ok: true,
        message: `${configPath} not present (skipped)`,
      };
    }
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const block = parsed[key] as Record<string, unknown> | undefined;
      const hasMemento = block !== undefined && Object.keys(block).some((k) => k === 'memento');
      return {
        name,
        ok: true,
        message: hasMemento
          ? `${configPath}: memento entry present under \`${key}\``
          : `${configPath}: no memento entry under \`${key}\` (run \`memento init\` to get a snippet)`,
      };
    } catch (cause) {
      return {
        name,
        ok: false,
        message: `${configPath}: failed to read or parse: ${describe(cause)}`,
      };
    }
  });
}
