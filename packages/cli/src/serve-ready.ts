// `memento serve` readiness banner.
//
// Why this module exists
// ----------------------
//
// `memento serve` runs the MCP byte transport on stdout. We
// can't write a single byte to stdout that isn't a JSON-RPC
// frame or every connected client breaks. But a human running
// `memento serve` directly in a terminal sees nothing — no
// prompt, no status, no confirmation that the server actually
// started — and assumes the process is stuck.
//
// The fix is to emit a readiness line on **stderr**, which:
//
//   - MCP clients ignore (they only consume stdout) or surface
//     in a separate log pane (Claude Desktop, VS Code MCP), so
//     we never corrupt the protocol.
//   - A human at a terminal sees normally.
//
// Gating
// ------
//
// Even on stderr we only emit when `process.stderr.isTTY` is
// true. When an MCP client launches us, stderr is a pipe and we
// stay silent, keeping client logs clean. The TTY check happens
// at the call site (`runServe`); this module is a pure renderer.
//
// Output shape
// ------------
//
// One line, no ANSI by default; colour follows the same
// `NO_COLOR` / `FORCE_COLOR` precedence as `renderBanner`. The
// line names the version and the resolved DB path so the
// operator can confirm the server is talking to the database
// they think it is.

export interface ServeReadyOptions {
  /** When true, wrap the message in ANSI colour escapes. */
  readonly color: boolean;
}

/**
 * Render the `memento serve` readiness line as a single string
 * ending in `\n`. Pure; safe to call from tests.
 *
 * Format:
 *   `memento <version> · MCP server ready on stdio · db: <dbPath>\n`
 *   `press Ctrl-C to stop\n`
 */
export function renderServeReady(
  version: string,
  dbPath: string,
  options: ServeReadyOptions,
): string {
  const head = `memento ${version} · MCP server ready on stdio · db: ${dbPath}`;
  const tail = 'press Ctrl-C to stop';
  if (!options.color) {
    return `${head}\n${tail}\n`;
  }
  return `${cyan(head)}\n${dim(tail)}\n`;
}

const RESET = '\u001b[0m';
const CYAN = '\u001b[36m';
const DIM = '\u001b[2m';

function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}

function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}
