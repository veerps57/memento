// `memento serve` — run the MCP server over stdio.
//
// Composes three pieces:
//
//   1. `deps.createApp` builds a fully-wired `MementoApp`
//      (database open, migrations run, registry frozen).
//   2. `deps.serveStdio` builds the MCP `Server` from the
//      registry, attaches a `StdioServerTransport`, and blocks
//      until the transport closes (parent disconnects or peer
//      sends `close`).
//   3. `app.shutdown()` runs in a `finally` so the database
//      handle is released even if the transport throws. The
//      graceful drain awaits any in-flight startup-embedding
//      backfill (ADR-0021) before closing — without it, a SIGINT
//      mid-inference can race the embedder's ONNX worker threads
//      and abort the process with a libc++ mutex trap.
//
// Why a lifecycle command and not a registry command:
//
//   - Its job is to *expose* the registry to MCP clients, not
//     to be a member of it. Self-reference would be incoherent.
//   - It has no input/output schema worth declaring; success
//     means "I ran until you disconnected".
//   - It owns stdout (as the MCP byte transport) and therefore
//     cannot be rendered by the standard `Result` pipeline.
//     The dispatcher special-cases this — `dispatch` skips
//     rendering on the success path. Errors still go to stderr
//     via the standard pipeline because stderr is never the
//     transport.
//
// Actor identity
// --------------
//
// Every command handler the MCP adapter invokes records an
// audit event. The actor is pinned at server construction time
// per ADR-0003 — the MCP protocol does not carry per-call
// actor identity, so making it per-call would force clients to
// embed it in every request. We use
// `{ type: 'mcp', agent: 'memento/<version>' }`. The `agent`
// field is a free-form audit label; using the binary's own
// name+version is the most informative value we can supply
// without parsing the `initialize` request (which `buildMementoServer`
// does not currently expose). When v2 lands per-client agent
// strings, this becomes a derivation from the handshake.
//
// Failure modes
// -------------
//
//   - `createApp` throws → `STORAGE_ERROR` (mirrors `context`).
//   - `serveStdio` throws → `INTERNAL` (transport- or SDK-level
//     failure; the user-meaningful detail is in the message).
//
// Both paths run through `app.shutdown()` exactly once via the
// `finally` block, including the case where `app` was never
// assigned because `createApp` itself threw.

import type { CommandContext } from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { renderBanner, shouldUseColor } from '../banner.js';
import { resolveServeLogPath, writeServeLogLine } from '../serve-log.js';
import { renderServeReady } from '../serve-ready.js';
import { resolveVersion } from '../version.js';
import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

export const serveCommand: LifecycleCommand = {
  name: 'serve',
  description: 'Run the MCP server over stdio (blocks until the peer disconnects)',
  run: runServe,
};

export async function runServe(deps: LifecycleDeps, input: LifecycleInput): Promise<Result<void>> {
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) {
    // MCP clients launch `serve` without a visible terminal, so
    // a startup failure (bad path, ABI mismatch, missing peer
    // dep) shows up in the host's logs as a cryptic spawn error
    // — if at all. Append a one-line ISO-timestamped diagnostic
    // to a stable log path so the operator has a place to look
    // before they need to reproduce the failure interactively.
    const logPath = resolveServeLogPath({ env: input.io.env });
    await writeServeLogLine(logPath, {
      level: 'error',
      event: 'open-failed',
      dbPath: input.env.dbPath,
      code: opened.error.code,
      message: opened.error.message,
    });
    return err({
      ...opened.error,
      hint:
        opened.error.hint ??
        `serve failed before the MCP transport opened. Diagnostics appended to ${logPath}; run \`memento doctor\` for details.`,
    });
  }
  const app = opened.value;

  const version = resolveVersion();
  const ctx: CommandContext = {
    actor: { type: 'mcp', agent: `memento/${version}` },
  };

  // Human-facing readiness output. Stderr is safe (stdout is
  // the MCP byte transport); we additionally gate on
  // `isStderrTTY` so MCP clients that launch us with piped
  // stderr see no chatter in their logs. The figlet banner
  // matches what `--help` shows so a fresh terminal feels
  // identifiably "memento"; the readiness line below carries
  // the load-bearing info (version + db path + how to stop).
  //
  // `MEMENTO_INIT_DONE=1` is the opt-out: orchestrators that
  // already showed their own onboarding (today: `memento ping`,
  // tomorrow: a future `init --write` once it lands) set the
  // flag to suppress the banner so child output stays clean.
  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
  if (input.io.isStderrTTY && input.io.env['MEMENTO_INIT_DONE'] !== '1') {
    const color = shouldUseColor(input.io.env, input.io.isStderrTTY);
    input.io.stderr.write(renderBanner(version, { color }));
    input.io.stderr.write(renderServeReady(version, input.env.dbPath, { color }));
  }

  try {
    await deps.serveStdio({
      registry: app.registry,
      ctx,
      info: { name: 'memento', version },
      maxMessageBytes: app.configStore.get('server.maxMessageBytes'),
    });
    return ok(undefined);
  } catch (cause) {
    const logPath = resolveServeLogPath({ env: input.io.env });
    const message = describe(cause);
    await writeServeLogLine(logPath, {
      level: 'error',
      event: 'transport-failed',
      dbPath: input.env.dbPath,
      message,
    });
    return err({
      code: 'INTERNAL',
      message: `mcp stdio transport failed: ${message}`,
      hint: `transport failure logged to ${logPath}.`,
    });
  } finally {
    await app.shutdown();
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
