// Lifecycle commands — types.
//
// Three commands sit outside the registry because they don't fit
// `AnyCommand`'s shape (no input/output Zod schemas, no
// `sideEffect`, no surface filtering). Instead, each lifecycle
// command is a function `(deps, input) -> Promise<Result<T>>`.
// The dispatcher pipes the result through `renderResult` and
// maps the error code (if any) to a process exit code, so the
// rendering pipeline is the same as for registry commands.
//
// Why `Result` and not a bespoke shape:
//
// - One render path. `renderResult` is the only thing that
//   touches `Result<unknown>`; lifecycle commands plug into it
//   without a second formatter.
// - One exit-code mapping. `ERROR_CODE_TO_EXIT` already covers
//   every `MementoError` code; lifecycle errors (e.g. a bad
//   `--db` path producing `STORAGE_ERROR`) get the same number
//   they would from a registry command.
//
// `serve` is the one lifecycle command whose result is "I ran
// until shutdown" — it returns `Result<void>` and never produces
// stdout payload because stdout is the MCP transport. The
// dispatcher special-cases the success path to suppress
// rendering for serve.

import type {
  CommandContext,
  CommandRegistry,
  CreateMementoAppOptions,
  EmbeddingProvider,
  MementoApp,
  MigrationOutcome,
} from '@psraghuveer/memento-core';
import type { Result } from '@psraghuveer/memento-schema';

import type { CliEnv } from '../argv.js';
import type { CliIO } from '../io.js';

/**
 * Dependencies that lifecycle commands consume. Injected so
 * tests can swap `createApp` (or `migrateStore` / `serveStdio`)
 * for a fake without spawning real SQLite or transports.
 *
 * `migrateStore` is its own seam (separate from `createApp`)
 * because `memento store migrate` is the *initialization* step —
 * it must run before a full `createMementoApp` succeeds against
 * a fresh DB, and we want to surface migration outcomes (which
 * `createApp` swallows). Tests stub it directly.
 *
 * `serveStdio` is its own seam because the MCP server's stdio
 * lifecycle (build server → connect transport → block until
 * close) is owned by `@psraghuveer/memento-server`. The CLI composes:
 * `createApp` → `serveStdio` → `app.close()`. Tests stub
 * `serveStdio` with a resolved promise to assert the wiring
 * without mounting a real transport.
 */
export interface LifecycleDeps {
  readonly createApp: (options: CreateMementoAppOptions) => Promise<MementoApp>;
  readonly migrateStore: (options: MigrateStoreOptions) => Promise<readonly MigrationOutcome[]>;
  readonly serveStdio: (options: ServeStdioOptions) => Promise<void>;
  /**
   * Resolve the optional local embedding provider on demand.
   *
   * Called by {@link openAppForSurface} only when
   * `retrieval.vector.enabled` is true. Returns `undefined`
   * when the peer package (`@psraghuveer/memento-embedder-local`) cannot be
   * resolved on the host — `openAppForSurface` translates that
   * into a `CONFIG_ERROR` with an install hint, instead of
   * silently leaving the engine without a provider (which would
   * surface as a delayed `CONFIG_ERROR` at the first
   * `memory.search` call).
   *
   * Optional. When omitted, `openAppForSurface` behaves as if
   * the function returned `undefined` — which is fine for tests
   * that do not flip `retrieval.vector.enabled`. Production
   * (`run.ts`) always supplies the real implementation.
   */
  readonly resolveEmbedder?: () => Promise<EmbeddingProvider | undefined>;
  /**
   * Spawn the dashboard server, bind it to the requested
   * host:port, open the browser if requested, and block until
   * SIGINT / SIGTERM. Returns the resolved bind information
   * once shutdown completes.
   *
   * Owns the entire "server lifetime" — start, run, stop —
   * so `runDashboard` can stay declarative. Production
   * (`run.ts`) supplies a default that dynamic-imports
   * `@psraghuveer/memento-dashboard`, `@hono/node-server`, and
   * `open`; tests inject a fake that resolves immediately
   * without binding a port or installing signal handlers.
   *
   * Optional only because lifecycle commands other than
   * `dashboard` never call it. `runDashboard` requires it.
   */
  readonly launchDashboard?: (options: LaunchDashboardOptions) => Promise<LaunchDashboardResult>;
}

/**
 * Options handed to {@link LifecycleDeps.launchDashboard}.
 *
 * `registry` and `ctx` are the engine surface the dashboard
 * server wraps. `port`, `host`, and `shouldOpen` are the
 * caller-supplied (or defaulted) launch parameters. `io` lets
 * the launcher emit the "dashboard ready · <url>" readiness
 * line on stderr without `runDashboard` having to know about
 * the surface.
 */
export interface LaunchDashboardOptions {
  readonly registry: CommandRegistry;
  readonly ctx: CommandContext;
  /** Requested port; `0` means "OS picks". The launcher returns the resolved port in the result. */
  readonly port: number;
  /** Bind host. The launcher accepts only `127.0.0.1` (canonicalised from `localhost` upstream). */
  readonly host: string;
  /** Whether to open the user's default browser after binding. */
  readonly shouldOpen: boolean;
  /** Used to emit the readiness line on stderr when `isStderrTTY`. */
  readonly io: CliIO;
  /** Memento package version, embedded in the readiness line. */
  readonly version: string;
}

/**
 * Result of a completed dashboard launch — populated after the
 * server has bound, served traffic, and shut down via SIGINT /
 * SIGTERM. Returned by {@link LifecycleDeps.launchDashboard}
 * and forwarded verbatim into the lifecycle command's snapshot.
 */
export interface LaunchDashboardResult {
  /** Final URL the server was reachable at (e.g. `http://localhost:51234`). */
  readonly url: string;
  /** Resolved port — equal to `port` when nonzero, otherwise the OS-picked port. */
  readonly port: number;
  /** Bind host as supplied. */
  readonly host: string;
  /** Whether the browser-open call actually succeeded. */
  readonly opened: boolean;
}

/** Options accepted by {@link LifecycleDeps.migrateStore}. */
export interface MigrateStoreOptions {
  readonly dbPath: string;
}

/**
 * Options accepted by {@link LifecycleDeps.serveStdio}.
 *
 * Mirrors `BuildMementoServerOptions` from `@psraghuveer/memento-server`
 * but is owned here so the CLI does not pull MCP SDK types
 * into its own surface. The default impl in `run.ts` forwards
 * straight through.
 */
export interface ServeStdioOptions {
  readonly registry: CommandRegistry;
  readonly ctx: CommandContext;
  readonly info: {
    readonly name: string;
    readonly version: string;
  };
}

/**
 * Per-invocation input for a lifecycle command. Carries the
 * resolved CLI environment (db path, config overrides) plus
 * subcommand-specific positional args and the IO surface for
 * commands that own their own streaming output (today: only
 * `serve`).
 */
export interface LifecycleInput {
  readonly env: CliEnv;
  readonly subargs: readonly string[];
  readonly io: CliIO;
}

/**
 * A lifecycle command. The runtime invokes `run` exactly once
 * per process; the returned `Result` flows through the standard
 * render+exit pipeline.
 */
export interface LifecycleCommand {
  readonly name: string;
  readonly description: string;
  run(deps: LifecycleDeps, input: LifecycleInput): Promise<Result<unknown>>;
}
