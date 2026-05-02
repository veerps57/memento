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

import os from 'node:os';
import path from 'node:path';

import { renderBanner } from './banner.js';
import type { InitSnapshot, SkillInstallInfo } from './lifecycle/init.js';

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
  const { version, dbPath, dbFromEnv, dbFromDefault, checks, clients, skill } = snapshot;
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

  // Skill section — only when the rendered client set has at
  // least one Anthropic-skill-capable client. Suppressed for
  // pure third-party setups (Cursor / VS Code Agent / OpenCode).
  if (skill.capableClients.length > 0) {
    lines.push(...renderSkillSection(skill, options));
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
  lines.push(
    `             ${bold('memento ping', options)}      \u2014 round-trip an MCP tools/list`,
  );
  lines.push('');
  lines.push(
    `Next:        ${bold('memento status', options)}    \u2014 what's in your store (counts, last event, db size)`,
  );
  lines.push(`             ${bold('memento dashboard', options)} \u2014 browse it in the browser`);
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

/**
 * Render the optional "Memento skill" section.
 *
 * Why a separate section
 * ----------------------
 *
 * The MCP snippet wires the *server*. The skill bundle wires
 * the *assistant's behaviour against that server* (when to call
 * `memory.write`, what scope to pick, when to supersede, etc.)
 * — closing the adoption gap that ADR-0016 names. Surfacing it
 * here is the one moment we reliably have the user's attention
 * during onboarding; documenting it elsewhere has historically
 * meant most users never find it.
 *
 * Three branches based on `skill`:
 *
 *   - `source` is non-null: print the absolute path and a
 *     copy-paste install command targeting `~/.claude/skills/`.
 *   - `source` is null: the build did not stage the skill
 *     (e.g. dev environment that has not run `pnpm build`).
 *     Print a docs-link fallback instead of a broken path —
 *     the section still announces the skill exists.
 *   - `capableClients` is empty: caller already filtered the
 *     section out before calling this helper.
 *
 * The display path uses `~/.claude/skills/` rather than the
 * fully-expanded `os.homedir()` form because the user's shell
 * expands `~` and the docs use the tilde form. We keep the
 * fully-expanded path on the snapshot for programmatic
 * consumers (a future `--install-skill` flag).
 */
function renderSkillSection(skill: SkillInstallInfo, options: InitRenderOptions): string[] {
  const lines: string[] = [];
  const header = '── Memento skill (optional, for Claude Code / Claude Desktop / Cowork) ──';
  lines.push(bold(header, options));
  lines.push('');
  lines.push('Anthropic-skill-capable clients can auto-load Memento usage rules — when to');
  lines.push('write, recall, confirm, supersede, forget, and extract memories — without any');
  lines.push('persona-file edits. The bundle ships with this package; install it once and');
  lines.push("the assistant behaves as if you'd hand-written the persona snippet.");
  lines.push('');

  if (skill.source !== null) {
    const target = displayHomePath(skill.suggestedTarget);
    lines.push('Install with:');
    lines.push('');
    lines.push(`  mkdir -p ${target}`);
    lines.push(`  cp -R "${skill.source}" ${target}/`);
    lines.push('');
    lines.push('Restart your client; the skill auto-loads on intent match.');
  } else {
    // Source not bundled — happens in dev environments where
    // the build's `copy-skills` step has not run. Don't fabricate
    // a path; point at the canonical source instead.
    lines.push(
      `${yellow('!', options)} the skill bundle is not staged on this install — usually a dev`,
    );
    lines.push('  checkout that has not run `pnpm build`. To install from a clone:');
    lines.push('');
    lines.push(`  cp -R skills/memento ${displayHomePath(skill.suggestedTarget)}/`);
    lines.push('');
    lines.push(
      'For a normal `npx` / global install, file an issue — the skill should ship with the package.',
    );
  }
  lines.push('');
  lines.push(
    `${dim('Other clients (Cursor, VS Code Agent, OpenCode):', options)} skills are an Anthropic-`,
  );
  lines.push('  product feature. Use the persona snippet in docs/guides/teach-your-assistant.md.');
  lines.push('');
  return lines;
}

/**
 * Replace the user's home directory with `~` for display. Keeps
 * the rendered command short and matches the conventions in the
 * rest of the walkthrough (and in the docs). Falls back to the
 * absolute path when it does not start under `$HOME`.
 */
function displayHomePath(absolute: string): string {
  const home = os.homedir();
  if (home.length > 0 && absolute.startsWith(home + path.sep)) {
    return `~${absolute.slice(home.length)}`;
  }
  if (absolute === home) return '~';
  return absolute;
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
