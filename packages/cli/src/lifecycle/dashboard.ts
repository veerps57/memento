// `memento dashboard` — launch the local web dashboard.
//
// What this command does
// ----------------------
//
//   1. Parse subargs (`--port`, `--host`, `--no-open`).
//   2. `deps.createApp` opens a `MementoApp` against the
//      configured database (open, migrate, freeze the registry).
//   3. `deps.launchDashboard` (production: dynamic-imports
//      `@psraghuveer/memento-dashboard`, `@hono/node-server`,
//      `open`) builds the dashboard server, binds it on
//      `127.0.0.1`, opens the browser, and blocks until SIGINT
//      / SIGTERM. Returns the resolved URL/port. Tests inject a
//      fake that resolves immediately without binding.
//   4. `app.shutdown()` drains any in-flight startup-embedding
//      backfill (ADR-0021) within the configured grace window,
//      then releases the database handle. The graceful drain
//      stops Ctrl-C from racing the embedder's ONNX worker
//      threads and aborting the process with a libc++ mutex trap.
//
// Why a lifecycle command and not a registry command:
//
//   - Same logic as `serve`: this command exposes the registry
//     to a different surface (HTTP for the dashboard's UI),
//     which is incoherent as a registry member.
//   - It owns long-lived state (HTTP server, signal handlers)
//     that registry commands deliberately do not.
//
// Why `launchDashboard` is a `LifecycleDeps` field rather than
// inlined here: testability. The "dynamic import + bind + open
// + wait for signal" dance is the entire untestable surface of
// the lifecycle command — every other line is pure logic. Pushing
// that surface behind a deps seam means the command itself can be
// covered without spawning real servers, processes, or installing
// signal handlers. The default implementation lives in `run.ts`.
//
// Per ADR-0018, the lifecycle command is the dashboard's only
// CLI surface; the dashboard's `/api/*` routes are private
// implementation details, not part of the documented programmatic
// surface.

import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';
import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

const DEFAULT_PORT = 0; // 0 = OS picks an available port
const DEFAULT_HOST = '127.0.0.1';

/** Shape of the snapshot returned on success. Stable contract. */
export interface DashboardSnapshot {
  readonly version: string;
  readonly url: string;
  readonly port: number;
  readonly host: string;
  readonly opened: boolean;
}

/**
 * Subargs accepted by `memento dashboard`.
 *
 * - `--port <n>`   bind to this port; default `0` lets the OS pick.
 * - `--host <a>`   bind to this host; default `127.0.0.1`. Only
 *                   `127.0.0.1` and `localhost` are accepted in
 *                   v0 — the dashboard is single-user.
 * - `--no-open`    skip auto-opening the browser. Used by full-stack
 *                   dev where Vite is the visible surface, or when
 *                   running headless.
 *
 * Exported so tests can exercise the parser directly without
 * spinning up a fake `LifecycleDeps`.
 */
export interface DashboardSubargs {
  readonly port: number;
  readonly host: string;
  readonly open: boolean;
}

export const dashboardCommand: LifecycleCommand = {
  name: 'dashboard',
  description: 'Launch the local web dashboard (browser UI for browsing and curating memory)',
  run: runDashboard,
};

export async function runDashboard(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<DashboardSnapshot>> {
  const parsed = parseDashboardSubargs(input.subargs);
  if (!parsed.ok) return parsed;
  const { port, host, open: shouldOpen } = parsed.value;

  if (deps.launchDashboard === undefined) {
    // The host did not wire a launcher. This is a configuration
    // bug, not a user error: production wires the default in
    // `run.ts`, and any other host (tests, embedded use) is
    // responsible for supplying its own. We surface it as
    // INTERNAL so the user sees the misconfiguration rather
    // than a runtime crash.
    return err({
      code: 'INTERNAL',
      message:
        'memento dashboard: launchDashboard is not wired. The CLI host must supply a `launchDashboard` impl on `LifecycleDeps`.',
    });
  }

  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  const app = opened.value;

  // The dashboard is invoked from the CLI; every audit event
  // it emits is attributed to a `cli` actor. The MCP-shaped
  // actor with an `agent` field is reserved for the MCP server.
  //
  // try/finally so that a launcher throw (broken
  // `@hono/node-server`, port conflict, killed mid-bind) does
  // not leak the database handle. Mirrors `runServe`'s
  // pattern. Launcher failures are mapped to INTERNAL — the
  // user-meaningful detail rides on the message.
  try {
    const result = await deps.launchDashboard({
      registry: app.registry,
      ctx: { actor: { type: 'cli' } },
      port,
      host,
      shouldOpen,
      io: input.io,
      version: resolveVersion(),
    });
    return ok({
      version: resolveVersion(),
      url: result.url,
      port: result.port,
      host: result.host,
      opened: result.opened,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({
      code: 'INTERNAL',
      message: `dashboard launch failed: ${message}`,
    });
  } finally {
    await app.shutdown();
  }
}

/**
 * Parse `memento dashboard` subargs. Pure; exported for tests
 * that want to exercise the parser directly without going
 * through `runDashboard`.
 */
export function parseDashboardSubargs(subargs: readonly string[]): Result<DashboardSubargs> {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let open = true;
  for (let i = 0; i < subargs.length; i += 1) {
    const arg = subargs[i] as string;
    const [flag, inlineValue] = splitFlag(arg);
    if (flag === '--port') {
      const raw = inlineValue ?? subargs[++i];
      if (raw === undefined) {
        return err({ code: 'INVALID_INPUT', message: '--port requires a value' });
      }
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) {
        return err({
          code: 'INVALID_INPUT',
          message: `--port must be an integer in 0..65535 (got '${raw}')`,
        });
      }
      port = n;
      continue;
    }
    if (flag === '--host') {
      const raw = inlineValue ?? subargs[++i];
      if (raw === undefined) {
        return err({ code: 'INVALID_INPUT', message: '--host requires a value' });
      }
      if (raw !== '127.0.0.1' && raw !== 'localhost') {
        return err({
          code: 'INVALID_INPUT',
          message: `--host must be '127.0.0.1' or 'localhost' in v0 (got '${raw}'). The dashboard is single-user.`,
        });
      }
      host = raw === 'localhost' ? '127.0.0.1' : raw;
      continue;
    }
    if (flag === '--no-open') {
      open = false;
      continue;
    }
    if (flag === '--open') {
      open = true;
      continue;
    }
    return err({
      code: 'INVALID_INPUT',
      message: `unknown argument '${arg}' for 'dashboard' (accepted: --port <n>, --host 127.0.0.1|localhost, --no-open)`,
    });
  }
  return ok({ port, host, open });
}

function splitFlag(arg: string): readonly [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq > 0) {
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}
