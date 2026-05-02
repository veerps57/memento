// `runCli` — the single dispatch entry point.
//
// `cli.ts` (the shebang binary) is ~10 lines that delegate here.
// Everything else — argv parsing, lifecycle dispatch, registry
// dispatch, error rendering — lives below this function in a
// pure-async pipeline you can drive from a Vitest test by
// passing a fake `CliIO` and fake deps.
//
// `dispatch` returns a numeric exit code; `runCli` calls
// `io.exit` exactly once at the end. Subcommands therefore
// never call `process.exit` themselves — exit codes are values,
// just like errors.
//
// `RunCliDeps` is the seam tests use to swap `createMementoApp`
// for a fake. Production passes the real implementation; tests
// pass an in-memory builder.

import {
  type EmbeddingProvider,
  MIGRATIONS,
  type MigrationOutcome,
  createMementoApp,
  migrateToLatest,
  openDatabase,
} from '@psraghuveer/memento-core';
import { type Result, assertNever } from '@psraghuveer/memento-schema';
import { serveStdio } from '@psraghuveer/memento-server';

import { type ParsedCommand, parseArgv } from './argv.js';
import { renderBanner, shouldUseColor } from './banner.js';
import { ERROR_CODE_TO_EXIT, EXIT_OK, EXIT_USAGE } from './exit-codes.js';
import { renderHelp } from './help.js';
import { renderInitText } from './init-render.js';
import type { CliIO } from './io.js';
import {
  type InitSnapshot,
  LIFECYCLE_COMMANDS,
  type LifecycleDeps,
  type MigrateStoreOptions,
  type ServeStdioOptions,
} from './lifecycle/index.js';
import { runRegistry } from './registry-run.js';
import { renderResult, resolveFormat } from './render.js';
import { resolveVersion } from './version.js';

/**
 * Injected dependencies. Defaults to the real bootstrap; tests
 * pass an in-memory `createApp` returning a fake `MementoApp`.
 */
export type RunCliDeps = LifecycleDeps;

/**
 * Default `migrateStore` implementation. Opens a raw database
 * handle, runs every registered migration, and closes the
 * handle in a `finally` so a partial migration still releases
 * the file lock. Lives here (not in core) because the act of
 * "open + migrate + close" is a CLI concern; core exposes the
 * primitives, the CLI composes them.
 */
async function defaultMigrateStore(
  options: MigrateStoreOptions,
): Promise<readonly MigrationOutcome[]> {
  const handle = openDatabase({ path: options.dbPath });
  try {
    return await migrateToLatest(handle.db, MIGRATIONS);
  } finally {
    handle.close();
  }
}

/**
 * Default `serveStdio` implementation. Forwards straight to
 * `@psraghuveer/memento-server`'s entry point. Lives here so the lifecycle
 * command stays decoupled from the MCP SDK at the type level
 * (`LifecycleDeps.serveStdio` is a plain `(opts) => Promise<void>`).
 */
async function defaultServeStdio(options: ServeStdioOptions): Promise<void> {
  await serveStdio({
    registry: options.registry,
    ctx: options.ctx,
    info: options.info,
  });
}

/**
 * Default `resolveEmbedder` implementation. Used by
 * {@link openAppForSurface} when `retrieval.vector.enabled` is
 * true.
 *
 * `@psraghuveer/memento-embedder-local` is a regular dependency
 * of this package, so the import should always succeed. If it
 * doesn't (broken install, corrupted node_modules), we let the
 * error propagate — `openAppForSurface` wraps it in a
 * CONFIG_ERROR with a reinstall hint.
 */
async function defaultResolveEmbedder(): Promise<EmbeddingProvider | undefined> {
  const mod = (await import('@psraghuveer/memento-embedder-local')) as {
    readonly createLocalEmbedder: () => EmbeddingProvider;
  };
  return mod.createLocalEmbedder();
}

/**
 * Default `launchDashboard` implementation. Owns the entire
 * "spawn HTTP server, bind, open browser, wait for SIGINT,
 * shut down" lifetime so `runDashboard` itself stays
 * declarative and testable.
 *
 * Uses dynamic imports for `@psraghuveer/memento-dashboard`,
 * `@hono/node-server`, and `open` so non-dashboard CLI
 * invocations (`memento serve`, `memento doctor`, etc.) do
 * not pay the load cost.
 *
 * Display host: emits the readiness URL with `localhost`
 * rather than `127.0.0.1` because some browsers treat the
 * two differently for cookie scoping. The bound socket is
 * still `127.0.0.1`.
 *
 * Failure handling: a thrown error from the dashboard
 * package or `@hono/node-server` propagates; `runDashboard`'s
 * caller surfaces it as `INTERNAL`. The `open` call is
 * best-effort — failures are swallowed because the dashboard
 * is fully usable via the printed URL even when the browser
 * fails to launch (headless servers, missing `xdg-open`).
 */
async function defaultLaunchDashboard(
  options: import('./lifecycle/types.js').LaunchDashboardOptions,
): Promise<import('./lifecycle/types.js').LaunchDashboardResult> {
  const dashboardModule = (await import('@psraghuveer/memento-dashboard')) as {
    readonly createDashboardServer: (init: {
      readonly registry: typeof options.registry;
      readonly ctx: typeof options.ctx;
    }) => { readonly fetch: (req: Request) => Promise<Response> };
  };
  type HonoServer = {
    readonly close: (cb?: () => void) => void;
    readonly on?: (event: string, listener: (err: Error) => void) => void;
  };
  const honoNode = (await import('@hono/node-server')) as {
    readonly serve: (
      init: {
        readonly fetch: (req: Request) => Promise<Response>;
        readonly hostname: string;
        readonly port: number;
      },
      onListen?: (info: { readonly address: string; readonly port: number }) => void,
    ) => HonoServer;
  };

  const serverApp = dashboardModule.createDashboardServer({
    registry: options.registry,
    ctx: options.ctx,
  });

  // `serve()` returns synchronously but `onListen` fires after
  // the socket is actually bound. We need the bound port (the
  // OS may have assigned one if `port` was 0) before we can
  // print or open the readiness URL — so we wrap the bind in
  // a Promise and await it. The `error` listener catches the
  // common "port already in use" case so the caller surfaces
  // a real error instead of hanging forever.
  let resolvedPort = options.port;
  const server: HonoServer = await new Promise<HonoServer>((resolveServer, rejectServer) => {
    const candidate = honoNode.serve(
      { fetch: serverApp.fetch, hostname: options.host, port: options.port },
      (info) => {
        resolvedPort = info.port;
        resolveServer(candidate);
      },
    );
    candidate.on?.('error', (err) => rejectServer(err));
  });

  const displayHost = options.host === '127.0.0.1' ? 'localhost' : options.host;
  const url = `http://${displayHost}:${resolvedPort}`;

  if (options.io.isStderrTTY) {
    options.io.stderr.write(
      `memento ${options.version} · dashboard ready · ${url}\npress Ctrl-C to stop\n`,
    );
  }

  let openedBrowser = false;
  if (options.shouldOpen) {
    try {
      const openModule = (await import('open')) as {
        readonly default: (target: string) => Promise<unknown>;
      };
      await openModule.default(url);
      openedBrowser = true;
    } catch {
      // Best-effort.
    }
  }

  await new Promise<void>((resolveSignal) => {
    const onSignal = (): void => {
      server.close(() => resolveSignal());
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });

  return { url, port: resolvedPort, host: options.host, opened: openedBrowser };
}

const DEFAULT_DEPS: RunCliDeps = {
  createApp: createMementoApp,
  migrateStore: defaultMigrateStore,
  serveStdio: defaultServeStdio,
  resolveEmbedder: defaultResolveEmbedder,
  launchDashboard: defaultLaunchDashboard,
};

/**
 * Run the CLI to completion. Always terminates the process via
 * `io.exit`. Returns `Promise<never>` to let callers `await
 * runCli(io)` without an explicit `// unreachable` comment.
 */
export async function runCli(io: CliIO, deps: RunCliDeps = DEFAULT_DEPS): Promise<never> {
  const code = await dispatch(parseArgv({ argv: io.argv, env: io.env }), io, deps);
  return io.exit(code);
}

async function dispatch(parsed: ParsedCommand, io: CliIO, deps: RunCliDeps): Promise<number> {
  switch (parsed.kind) {
    case 'version':
      io.stdout.write(`memento ${resolveVersion()}\n`);
      return EXIT_OK;

    case 'help':
      if (io.isTTY) {
        const color = shouldUseColor(io.env, io.isTTY);
        io.stdout.write(renderBanner(resolveVersion(), { color }));
      }
      io.stdout.write(renderHelp(parsed.topic));
      return EXIT_OK;

    case 'parseError':
      io.stderr.write(`error: ${parsed.message}\n\n`);
      io.stderr.write(renderHelp());
      return EXIT_USAGE;

    case 'lifecycle': {
      const command = LIFECYCLE_COMMANDS[parsed.name];
      const result = await command.run(deps, {
        env: parsed.env,
        subargs: parsed.subargs,
        io,
      });
      // `serve` owns stdout (it is the MCP byte transport), so
      // we never write a rendered Result to it. On success we
      // return EXIT_OK silently. On failure we still want the
      // operator to see what went wrong, so errors flow through
      // the standard pipeline (which writes to stderr only —
      // never stdout — so the now-disconnected peer is safe).
      if (parsed.name === 'serve' && result.ok) {
        return EXIT_OK;
      }
      // `init`'s success value is a structured snapshot whose
      // contents (per-client JSON snippets) are meant to be
      // pasted by a human. The standard text renderer would
      // JSON.stringify the whole thing, defeating the purpose.
      // On TTY+text we emit a tailored walkthrough; pipes /
      // scripts (json format) still get the clean snapshot via
      // the standard pipeline.
      if (parsed.name === 'init' && result.ok) {
        const format = resolveFormat(parsed.env.format, io.isTTY);
        if (format === 'text') {
          const color = shouldUseColor(io.env, io.isTTY);
          io.stdout.write(renderInitText(result.value as InitSnapshot, { color }));
          return EXIT_OK;
        }
      }
      return emitAndExit(result, parsed.env.format, io);
    }

    case 'registry': {
      const result = await runRegistry(deps, {
        env: parsed.env,
        subargs: parsed.subargs,
        io,
        commandName: parsed.commandName,
      });
      // `memory.list` returns an array of memory rows. The
      // generic text renderer JSON-pretty-prints arrays, which
      // becomes a wall of nested objects for any non-trivial
      // list. On TTY+text we project each row to a one-line
      // summary so `memento list` is human-scannable.
      if (parsed.commandName === 'memory.list' && result.ok) {
        const format = resolveFormat(parsed.env.format, io.isTTY);
        if (format === 'text') {
          io.stdout.write(renderMemoryListText(result.value));
          return EXIT_OK;
        }
      }
      return emitAndExit(result, parsed.env.format, io);
    }

    default:
      return assertNever(parsed);
  }
}

/**
 * Render a `Result` and translate it to a process exit code.
 * Centralised so every command path — lifecycle today,
 * registry from #26.5 — uses the same format resolution and
 * error→exit mapping.
 */
function emitAndExit(
  result: Result<unknown>,
  formatOption: 'json' | 'text' | 'auto',
  io: CliIO,
): number {
  const format = resolveFormat(formatOption, io.isTTY);
  const rendered = renderResult(result, format);
  if (rendered.stdout) io.stdout.write(rendered.stdout);
  if (rendered.stderr) io.stderr.write(rendered.stderr);
  return result.ok ? EXIT_OK : ERROR_CODE_TO_EXIT[result.error.code];
}

/**
 * One-line-per-memory text projection for `memento memory list`
 * (and the `memento list` sugar). Closes UX-audit J5: the
 * default text view used to be a JSON.stringify dump of the
 * entire array, unreadable past three or four rows.
 *
 * Format per row:
 *   <id>  <kind>  <scope>  [<tags>]  <content excerpt>
 *
 * `id` is shown in full (callers paste it into `memento read`
 * or `memento forget`). `content` is collapsed to a single line
 * and truncated; the operator can `memento read <id>` for the
 * full record. The empty-list case is a single line so scripts
 * piping `| wc -l` still get a deterministic shape.
 */
function renderMemoryListText(value: unknown): string {
  if (!Array.isArray(value)) return `${JSON.stringify(value, null, 2)}\n`;
  if (value.length === 0) return '(no memories)\n';
  const lines = value.map((row) => formatMemoryRow(row));
  return `${lines.join('\n')}\n`;
}

const CONTENT_EXCERPT_MAX = 80;

function formatMemoryRow(row: unknown): string {
  if (typeof row !== 'object' || row === null) return String(row);
  const r = row as {
    id?: unknown;
    kind?: unknown;
    scope?: unknown;
    tags?: unknown;
    pinned?: unknown;
    content?: unknown;
  };
  const id = typeof r.id === 'string' ? r.id : '?';
  const kind = typeof r.kind === 'string' ? r.kind : '?';
  const scope = formatScope(r.scope);
  const tags = Array.isArray(r.tags) && r.tags.length > 0 ? `[${r.tags.join(',')}]` : '';
  const pin = r.pinned === true ? '*' : ' ';
  const excerpt = formatExcerpt(r.content);
  const head = [pin, id, kind, scope, tags].filter((s) => s !== '').join(' ');
  return `${head}  ${excerpt}`;
}

function formatScope(scope: unknown): string {
  if (typeof scope === 'string') return scope;
  if (typeof scope === 'object' && scope !== null) {
    const s = scope as { type?: unknown; id?: unknown };
    if (typeof s.type === 'string') {
      return typeof s.id === 'string' ? `${s.type}:${s.id}` : s.type;
    }
  }
  return '?';
}

function formatExcerpt(content: unknown): string {
  if (content === null) return '(redacted)';
  if (typeof content !== 'string') return '';
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= CONTENT_EXCERPT_MAX) return oneLine;
  return `${oneLine.slice(0, CONTENT_EXCERPT_MAX - 1)}…`;
}
