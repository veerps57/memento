// `memento` startup banner.
//
// Shown on `memento` (bare), `memento --help`, and
// `memento --version`. Lifted slightly above ornamentation:
// it's the only first-impression surface a freshly-installed
// `npm i -g @psraghuveer/memento` user sees, and we want it to
// look intentional.
//
// Rules:
// - Never write to stdout if the consumer is a pipe or a script.
//   `serve` already owns stdout for MCP framing; for everything
//   else, banner output is opt-in via TTY detection upstream.
// - Honour `NO_COLOR` (https://no-color.org) and `FORCE_COLOR`.
//   When colour is off we still emit the ASCII art — colour is
//   icing, not the load-bearing thing.
// - Pure function of `(version, options)`. No side effects, no
//   `process` reads. The caller (run.ts) decides when to call it
//   based on `io.isTTY` and `io.env`.

const FIGLET = [
  '                                     _        ',
  ' _ __ ___   ___ _ __ ___   ___ _ __ | |_ ___  ',
  "| '_ ` _ \\ / _ \\ '_ ` _ \\ / _ \\ '_ \\| __/ _ \\ ",
  '| | | | | |  __/ | | | | |  __/ | | | || (_) |',
  '|_| |_| |_|\\___|_| |_| |_|\\___|_| |_|\\__\\___/ ',
];

const TAGLINE = 'Persistent memory for AI assistants';

export interface BannerOptions {
  /** When true, wrap the figlet in ANSI colour escapes. */
  readonly color: boolean;
}

/**
 * Decide whether banner output should use colour, given an
 * environment and a TTY hint. Centralised so call sites can stay
 * single-purpose.
 *
 * Precedence (matches the wider ecosystem):
 *   1. `NO_COLOR` set to any non-empty value -> no colour.
 *   2. `FORCE_COLOR` set to any non-empty, non-zero value -> colour.
 *   3. Otherwise, follow the TTY hint.
 */
export function shouldUseColor(
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean,
): boolean {
  const { NO_COLOR, FORCE_COLOR } = env;
  if (NO_COLOR !== undefined && NO_COLOR.length > 0) return false;
  if (FORCE_COLOR !== undefined && FORCE_COLOR !== '' && FORCE_COLOR !== '0') return true;
  return isTTY;
}

/**
 * Render the startup banner as a single string ending in `\n`.
 * Pure; safe to call from tests.
 */
export function renderBanner(version: string, options: BannerOptions): string {
  const lines = options.color ? FIGLET.map((line) => cyan(line)) : FIGLET.slice();
  const subtitle = `  ${TAGLINE}  ·  v${version}`;
  lines.push('');
  lines.push(options.color ? dim(subtitle) : subtitle);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// --- ANSI helpers ----------------------------------------------------------
// Kept inline (no chalk dependency) to honour our zero-dependency
// stance for the CLI binary; the codes are stable and tiny.

const RESET = '\u001b[0m';
const CYAN = '\u001b[36m';
const DIM = '\u001b[2m';

function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}

function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}
