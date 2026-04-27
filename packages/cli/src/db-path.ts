// Default DB-path resolution.
//
// The CLI used to default `--db` to `./memento.db` (cwd-relative).
// That's a footgun for an MCP server: the host process (Claude
// Desktop, Cursor, OpenCode, …) launches `memento serve` from
// *its own* cwd, which is rarely the repo where the user ran
// `memento init`. The user ends up with one DB on disk but the
// MCP client speaking to a different empty one created wherever
// the host happened to be.
//
// The new default is XDG-compliant and stable:
//
//   $XDG_DATA_HOME/memento/memento.db          if set
//   ~/.local/share/memento/memento.db          on Linux/macOS
//   %LOCALAPPDATA%\memento\memento.db          on Windows
//   ./memento.db                               last-resort fallback
//
// `MEMENTO_DB` and `--db` still take precedence; this only
// changes what happens when neither is provided.
//
// The helper does not create any directories. `init` and
// `doctor` do that work explicitly so the side-effect is visible
// at a known point in the lifecycle.

import os from 'node:os';
import path from 'node:path';

export interface ResolveDefaultDbPathOptions {
  /**
   * Process environment. Required so the resolver is a pure
   * function (testable without mocking `process.env`).
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Override `os.homedir()` for tests. Defaults to the live
   * value at call time.
   */
  readonly homedir?: () => string;
  /**
   * Override `process.platform` for tests. Defaults to the
   * live value.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Compute the XDG-compliant default DB path for this host.
 *
 * Pure: takes its environment as a parameter, performs no IO,
 * never creates directories. Callers that want the side-effect
 * (mkdir -p of the parent) do it themselves at the lifecycle
 * point where it makes sense.
 */
export function resolveDefaultDbPath(options: ResolveDefaultDbPathOptions): string {
  const { env } = options;
  const homedir = options.homedir ?? os.homedir;
  const platform = options.platform ?? process.platform;

  // Explicit XDG_DATA_HOME wins on every platform that respects it.
  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
  const xdg = env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg.length > 0) {
    return path.join(xdg, 'memento', 'memento.db');
  }

  if (platform === 'win32') {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.length > 0) {
      return path.join(localAppData, 'memento', 'memento.db');
    }
    // No LOCALAPPDATA — fall back to a homedir-relative path
    // so we never silently land in cwd.
    const home = safeHomedir(homedir);
    if (home !== undefined) {
      return path.join(home, 'AppData', 'Local', 'memento', 'memento.db');
    }
    return './memento.db';
  }

  // Linux, macOS, BSDs: XDG default is ~/.local/share.
  const home = safeHomedir(homedir);
  if (home !== undefined) {
    return path.join(home, '.local', 'share', 'memento', 'memento.db');
  }
  return './memento.db';
}

function safeHomedir(homedir: () => string): string | undefined {
  try {
    const value = homedir();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
