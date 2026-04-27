// Text rendering for `memento init`.
//
// Pure: input is `InitSnapshot`, output is a string. The
// dispatcher decides when to call this (TTY + text format) vs
// when to fall through to the standard JSON renderer (pipes /
// scripts / `--format json`).
//
// Why a custom renderer
// ---------------------
//
// The standard text renderer JSON-pretty-prints structured
// values. For `init` that would force the user to read the
// snippets through escaped newlines and quoted strings — the
// exact opposite of "ready to paste". A bespoke walkthrough
// keeps each snippet's JSON pristine and adds the contextual
// "where do I paste this" guidance you'd otherwise need to go
// hunt for in the docs.
//
// Colour: handled by the caller via simple optional ANSI
// helpers. We honour `NO_COLOR` / `FORCE_COLOR` upstream
// (`shouldUseColor`) the same way `banner.ts` does.

import { renderBanner } from './banner.js';
import type { InitSnapshot } from './lifecycle/init.js';

export interface InitRenderOptions {
  readonly color: boolean;
}

/**
 * Render the friendly init walkthrough. Includes the figlet
 * banner, a status header, every client snippet with its
 * target config path, and a footer pointing at
 * `memento doctor` for verification.
 */
export function renderInitText(snapshot: InitSnapshot, options: InitRenderOptions): string {
  const { version, dbPath, dbFromEnv, dbFromDefault, checks, clients } = snapshot;
  const memoryWarning = dbPath === ':memory:';

  const lines: string[] = [];
  // Banner first — same surface as `serve` so the user sees a
  // consistent visual identity across the two commands they
  // run during onboarding.
  lines.push(renderBanner(version, { color: options.color }).replace(/\n$/u, ''));
  lines.push(`${green('✓', options)} memento ${version}`);
  if (memoryWarning) {
    lines.push(
      `${yellow('!', options)} database is :memory: — every spawn will start with an empty store.`,
    );
    lines.push('  set MEMENTO_DB or pass --db /path/to/memento.db before running init.');
  } else {
    lines.push(`${green('✓', options)} database ready at ${dbPath}`);
    if (dbFromDefault) {
      // Default XDG path — stable across cwds, so no warning.
      // Mention the env override only as background info.
      lines.push(`  ${dim('(default location; override with MEMENTO_DB or --db)', options)}`);
    } else if (!dbFromEnv) {
      // Came from --db on this invocation. The snippet hard-codes
      // the absolute path, but the user almost certainly wants
      // a stable location they can rely on across shells.
      lines.push(
        `${yellow('!', options)} database path came from --db; the snippet pins the absolute path above.`,
      );
      lines.push(
        '  consider setting MEMENTO_DB or omitting --db so the XDG default is used everywhere.',
      );
    }
  }

  // Pre-flight checks. Surface failures inline so the user can
  // see what is wrong without chaining `memento doctor`.
  for (const check of checks) {
    const mark = check.ok ? green('✓', options) : yellow('!', options);
    lines.push(`${mark} ${check.message}`);
  }

  lines.push('');
  if (clients.length === 0) {
    lines.push(
      `${yellow('!', options)} no clients selected; pass --client <id[,id…]> or omit --client to see all.`,
    );
    lines.push('');
  } else {
    lines.push('Add memento to your AI assistant. Pick the client you use:');
    lines.push('');
    for (const client of clients) {
      const header = `── ${client.displayName} ──`;
      lines.push(bold(header, options));
      if (client.installHint !== undefined) {
        lines.push(`${dim('Easiest:', options)} ${client.installHint}`);
        lines.push('');
        lines.push(
          `${dim('Or edit', options)} ${dim(client.configPath, options)} ${dim('and merge:', options)}`,
        );
      } else {
        lines.push(`Edit ${dim(client.configPath, options)} and merge into the existing block:`);
      }
      lines.push('');
      lines.push(...indent(client.snippet.replace(/\n$/u, '').split('\n'), '  '));
      lines.push('');
    }
    lines.push(
      `${dim('Note:', options)} merge into any existing entries — do not replace the whole`,
    );
    lines.push('      `mcpServers` / `servers` / `mcp` block if your config already has one.');
    lines.push('');
  }

  lines.push(`${dim('Tip:', options)} clients with `);
  // The "swap to bare memento" tip is correct only for
  // command/args-shaped clients (Claude {Code, Desktop}, Cursor,
  // VS Code) — not for OpenCode whose shape merges command +
  // args into one array. Phrase it generically.
  lines.push('      `command` + `args` (Claude, Cursor, VS Code): replace the npx invocation with');
  lines.push(
    `      \`command: "memento", args: ["serve"]\` if memento is on PATH (e.g. via \`npm i -g\`).`,
  );
  lines.push(
    `      OpenCode: replace \`["npx","-y","@psraghuveer/memento","serve"]\` with \`["memento","serve"]\`.`,
  );
  lines.push('');
  lines.push(
    `${dim('Heads up:', options)} \`init\` is print-only by design \u2014 it does not write to your client's`,
  );
  lines.push('           config file. Pasting is a manual step.');
  lines.push('');
  lines.push(`Verify with: ${bold('memento doctor', options)}`);
  lines.push(`           ${bold('memento ping', options)}    \u2014 round-trip an MCP tools/list`);
  lines.push('');
  return `${lines.join('\n')}`;
}

/**
 * Indent every line in `lines` by `prefix`. Empty lines stay
 * empty so the surrounding blank-line spacing reads cleanly in
 * a terminal.
 */
function indent(lines: readonly string[], prefix: string): string[] {
  return lines.map((line) => (line.length === 0 ? line : `${prefix}${line}`));
}

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';

function green(s: string, opts: InitRenderOptions): string {
  return opts.color ? `${GREEN}${s}${RESET}` : s;
}

function yellow(s: string, opts: InitRenderOptions): string {
  return opts.color ? `${YELLOW}${s}${RESET}` : s;
}

function dim(s: string, opts: InitRenderOptions): string {
  return opts.color ? `${DIM}${s}${RESET}` : s;
}

function bold(s: string, opts: InitRenderOptions): string {
  return opts.color ? `${BOLD}${s}${RESET}` : s;
}
