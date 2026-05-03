// Append-only diagnostic log for `memento serve`.
//
// MCP clients launch `memento serve` as a subprocess and rarely
// surface stderr in a useful place. When the server fails to
// start (bad DB path, native-binding ABI mismatch, missing peer
// dep) the operator sees, at best, a single-line "MCP server
// crashed" notice in their assistant. The fix is to also write
// the failure to a stable log file so they have something to
// read, and so bug reports include real text.
//
// The file lives under the XDG state dir so it doesn't pollute
// the user's data directory and gets cleaned up by sensible
// defaults. We never read the log; we only append to it.
//
// Failures of the logger itself are swallowed: a logger that
// can't write must not turn a recoverable error into a fatal
// one (the caller has its own structured error to return).

import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ResolveServeLogPathOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Override `os.homedir()` for tests. */
  readonly homedir?: () => string;
  /** Override `process.platform` for tests. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Resolve the path to the serve log. Pure: performs no IO.
 *
 *   $XDG_STATE_HOME/memento/serve.log          if set
 *   ~/.local/state/memento/serve.log           on Linux/macOS
 *   %LOCALAPPDATA%\memento\serve.log           on Windows
 *   ./memento-serve.log                        last-resort fallback
 */
export function resolveServeLogPath(options: ResolveServeLogPathOptions): string {
  const { env } = options;
  const homedir = options.homedir ?? os.homedir;
  const platform = options.platform ?? process.platform;

  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
  const xdg = env['XDG_STATE_HOME'];
  if (xdg !== undefined && xdg.length > 0) {
    return path.join(xdg, 'memento', 'serve.log');
  }

  if (platform === 'win32') {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.length > 0) {
      return path.join(localAppData, 'memento', 'serve.log');
    }
    const home = safeHomedir(homedir);
    if (home !== undefined) {
      return path.join(home, 'AppData', 'Local', 'memento', 'serve.log');
    }
    return './memento-serve.log';
  }

  const home = safeHomedir(homedir);
  if (home !== undefined) {
    return path.join(home, '.local', 'state', 'memento', 'serve.log');
  }
  return './memento-serve.log';
}

export interface ServeLogEntry {
  readonly level: 'info' | 'error';
  readonly event: string;
  readonly [key: string]: unknown;
}

/**
 * Append one JSON line to the serve log, prefixed with an ISO
 * timestamp. Best-effort: filesystem failures are swallowed so
 * a logging failure never displaces the original error.
 */
export async function writeServeLogLine(logPath: string, entry: ServeLogEntry): Promise<void> {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  try {
    // Owner-only perms on both the parent directory and the log
    // file. Serve-log lines carry the resolved DB path and any
    // error message at startup; a permissive umask would expose
    // those to other accounts on a shared host.
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    await appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Intentional: the caller already has a structured error to
    // return. Refusing to log must not turn a recoverable error
    // into a fatal one.
  }
}

function safeHomedir(homedir: () => string): string | undefined {
  try {
    const value = homedir();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
