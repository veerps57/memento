// Auto-install the Memento persona snippet into user-scope
// custom-instructions files for AI clients detected on this
// machine.
//
// Why this exists
// ---------------
//
// Post-launch testing showed that the MCP `instructions` spine
// (ADR-0026) is typically not surfaced to the assistant's system
// prompt by current client implementations. The bundled skill is
// intent-triggered and doesn't fire on neutral first messages.
// The persona snippet — pasted by the user into a place the
// client definitely loads on every session — is the only reliable
// always-on channel.
//
// Telling users "paste this snippet into wherever your client
// stores custom instructions" works for everyone but is friction:
// each client puts the slot in a different place, and "wherever"
// is the wrong direction in an install flow. This module
// collapses the manual paste step into a y/N during `memento
// init`, for the subset of clients whose custom-instructions slot
// is a file we can write to.
//
// What it does
// ------------
//
//   1. Detect which AI clients are present on this machine via
//      lightweight filesystem probes (config file / known dir
//      existence). No network calls; no spawning subprocesses.
//   2. For each detected file-based client, write a
//      marker-wrapped block to the canonical user-scope
//      custom-instructions file. Idempotent: re-runs detect the
//      existing block and either no-op (content matches) or
//      replace it in place (content differs).
//   3. For each detected UI-only client (Cowork, Claude Desktop,
//      Claude Chat), surface a structured outcome carrying the
//      UI path the user must visit. The renderer prints
//      copy-paste instructions; we cannot reach those slots from
//      disk.
//
// The persona content itself is `MEMENTO_INSTRUCTIONS` from
// `@psraghuveer/memento-server` — the same string the server
// emits on the MCP initialize handshake. One source of truth for
// what we teach the assistant; one place to revise it.
//
// Markers and idempotency
// -----------------------
//
// Every block we write is wrapped:
//
//     <!-- memento:persona BEGIN v0.8.0 -->
//     ...snippet...
//     <!-- memento:persona END -->
//
// HTML comments are invisible in rendered markdown (Claude reads
// them in CLAUDE.md, but they don't appear in any human-rendered
// view). The version tag in BEGIN lets a future install detect
// stale blocks and refresh in place without churning the
// surrounding user content.
//
// Re-running `init` (or a future `memento persona install`):
//
//   - No block found              → append snippet + markers to
//                                    end of file; create file +
//                                    parent dir if missing.
//   - Block found, content equal  → no-op (`already-current`).
//   - Block found, content diffs  → splice the BEGIN..END range
//                                    out, append fresh block.
//                                    Reports `updated`.
//
// Uninstall (a follow-up command) strips the BEGIN..END range
// and leaves everything else untouched.
//
// What this module does NOT do
// ----------------------------
//
//   - Project-scope writes (`./AGENTS.md`, `./.cursor/rules/...`).
//     Deferred to a future `--project` flag; user-scope is the
//     high-value MVP.
//   - Detect or write to UI-only slots (Cowork, Claude Desktop,
//     Claude Chat, Cursor User Rules). The renderer carries the
//     paste-here instructions for those.
//   - Network calls. All probes are local filesystem checks.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Stable identifier for a persona-install target. */
export type PersonaClientId =
  | 'claude-code'
  | 'opencode'
  | 'cline'
  | 'cowork'
  | 'claude-desktop'
  | 'claude-chat'
  | 'cursor';

/**
 * A persona-install target — either a file we can write to or a
 * UI surface the user has to act on manually.
 */
export type PersonaTarget =
  | {
      readonly kind: 'file';
      readonly clientId: PersonaClientId;
      readonly displayName: string;
      /** Absolute path to the file we'd write to. */
      readonly path: string;
    }
  | {
      readonly kind: 'ui';
      readonly clientId: PersonaClientId;
      readonly displayName: string;
      /** Human-readable instruction for the user to follow. */
      readonly uiPath: string;
    };

/** Per-target install outcome surfaced in the `InitSnapshot`. */
export type PersonaInstallOutcome =
  | { readonly kind: 'installed'; readonly target: string }
  | { readonly kind: 'updated'; readonly target: string; readonly previousVersion: string | null }
  | { readonly kind: 'already-current'; readonly target: string }
  | { readonly kind: 'ui-only'; readonly displayName: string; readonly uiPath: string }
  | { readonly kind: 'failed'; readonly target: string; readonly message: string };

export interface PersonaInstallResult {
  readonly clientId: PersonaClientId;
  readonly displayName: string;
  readonly outcome: PersonaInstallOutcome;
}

/** Markers wrapping the auto-installed block. */
const MARKER_BEGIN_PREFIX = '<!-- memento:persona BEGIN';
const MARKER_BEGIN_SUFFIX = '-->';
const MARKER_END = '<!-- memento:persona END -->';

/**
 * Regex matching an existing memento persona block, including
 * the BEGIN/END comment lines. Captures the version stamp from
 * BEGIN so callers can report `previousVersion` on update.
 *
 * The version capture is lazy non-whitespace (`\S+?`) so it
 * accepts hyphens and dots within the stamp (e.g.
 * `v0.9.0-rc.1`) — the lazy match expands until the trailing
 * `\s*-->` succeeds. Greedy on whitespace at the block boundary
 * so re-installs collapse accumulated blank lines around the
 * block rather than growing the file on every run.
 */
const PERSONA_BLOCK_PATTERN =
  /(?:\n\n)?<!-- memento:persona BEGIN(?:\s+v(\S+?))?\s*-->\s*\n[\s\S]*?\n<!-- memento:persona END -->\s*/u;

/**
 * Build the marker-wrapped block to write into the target file.
 * Always prefixed by a blank line so the block visually
 * separates from preceding content; trailing newline for POSIX
 * file hygiene.
 */
function buildBlock(personaContent: string, version: string): string {
  return `\n\n${MARKER_BEGIN_PREFIX} v${version} ${MARKER_BEGIN_SUFFIX}\n\n${personaContent.trim()}\n\n${MARKER_END}\n`;
}

/**
 * Resolve the user-scope persona-target list for this host.
 * Probes for each client's presence; only the ones whose
 * canonical config/data directory exists end up in the returned
 * list. Pure of side effects beyond filesystem reads.
 *
 * Detection heuristics:
 *
 *   - Claude Code: `~/.claude/` exists OR `~/.claude.json` exists.
 *   - OpenCode: `~/.config/opencode/` exists.
 *   - Cline: `~/Documents/Cline/` exists (macOS / Linux / WSL) or
 *     `%USERPROFILE%\Documents\Cline\` (Windows).
 *   - Cowork: same `~/.claude/` probe as Claude Code (lives in
 *     the same desktop app). Surfaced as a UI-only target.
 *   - Claude Desktop: probe the per-OS Claude Desktop config
 *     directory. UI-only target.
 *   - Cursor: `~/.cursor/` exists. User Rules is UI-only.
 *
 * Claude Chat (claude.ai web) is never probed — there's no local
 * disk presence to detect and it's UI-only anyway. The init
 * renderer surfaces it as an unconditional "if you also use
 * Claude Chat, paste this into Settings → Profile → Custom
 * Instructions" line.
 */
export function detectPersonaTargets(homedir: string = os.homedir()): readonly PersonaTarget[] {
  const targets: PersonaTarget[] = [];

  // — Claude Code (file-based) + Cowork (UI-only, shares the dir
  //   on disk because they're sibling apps from the same vendor)
  const claudeDir = path.join(homedir, '.claude');
  const claudeJson = path.join(homedir, '.claude.json');
  if (existsSync(claudeDir) || existsSync(claudeJson)) {
    targets.push({
      kind: 'file',
      clientId: 'claude-code',
      displayName: 'Claude Code',
      path: path.join(claudeDir, 'CLAUDE.md'),
    });
    targets.push({
      kind: 'ui',
      clientId: 'cowork',
      displayName: 'Cowork (Claude Desktop)',
      uiPath: 'Claude Desktop → Settings → Cowork → Global instructions → Edit',
    });
  }

  // — OpenCode (file-based, AGENTS.md is the cross-tool standard
  //   OpenCode reads first; CLAUDE.md is the documented fallback)
  const opencodeDir = path.join(homedir, '.config', 'opencode');
  if (existsSync(opencodeDir)) {
    targets.push({
      kind: 'file',
      clientId: 'opencode',
      displayName: 'OpenCode',
      path: path.join(opencodeDir, 'AGENTS.md'),
    });
  }

  // — Cline (file-based)
  //   Per Cline docs: global rules live under `Documents/Cline/Rules`.
  //   We probe the `Documents/Cline` directory because the Rules
  //   subdir may not exist yet on a first install.
  const clineDir = path.join(homedir, 'Documents', 'Cline');
  if (existsSync(clineDir)) {
    targets.push({
      kind: 'file',
      clientId: 'cline',
      displayName: 'Cline',
      path: path.join(clineDir, 'Rules', 'memento.md'),
    });
  }

  // — Claude Desktop (UI-only). Probe the per-OS config dir to
  //   decide whether to surface the UI instruction; users without
  //   Claude Desktop installed shouldn't see a "go to Settings →
  //   ..." line for an app they don't use.
  const claudeDesktopDir = claudeDesktopConfigDir(homedir);
  if (claudeDesktopDir !== null && existsSync(claudeDesktopDir)) {
    targets.push({
      kind: 'ui',
      clientId: 'claude-desktop',
      displayName: 'Claude Desktop',
      uiPath: 'Claude Desktop → Settings → Custom Instructions',
    });
  }

  // — Cursor (UI-only for user-scope; project-scope `./.cursor/
  //   rules/` is deferred to a future `--project` flag).
  const cursorDir = path.join(homedir, '.cursor');
  if (existsSync(cursorDir)) {
    targets.push({
      kind: 'ui',
      clientId: 'cursor',
      displayName: 'Cursor',
      uiPath: 'Cursor → Settings → Rules → User Rules',
    });
  }

  // — Claude Chat (claude.ai web). Always surfaced as a UI
  //   target because we can't detect web-app usage from disk
  //   AND a user using *only* Claude Chat would have no other
  //   probe hit. The renderer can choose to suppress it if
  //   `file`-kind targets already cover the user's setup.
  targets.push({
    kind: 'ui',
    clientId: 'claude-chat',
    displayName: 'Claude (web / mobile)',
    uiPath: 'claude.ai → Settings → Profile → Custom Instructions',
  });

  return targets;
}

/**
 * Per-OS Claude Desktop config directory probe. Returns `null`
 * when we have no documented path for the host platform (rare —
 * the three values below cover macOS, Windows, Linux).
 */
function claudeDesktopConfigDir(homedir: string): string | null {
  switch (process.platform) {
    case 'darwin':
      return path.join(homedir, 'Library', 'Application Support', 'Claude');
    case 'win32': {
      // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
      const appData = process.env['APPDATA'];
      if (typeof appData === 'string' && appData.length > 0) {
        return path.join(appData, 'Claude');
      }
      return null;
    }
    case 'linux':
      return path.join(homedir, '.config', 'Claude');
    default:
      return null;
  }
}

/**
 * Install the persona snippet into every file-based target,
 * idempotently. UI-only targets are passed through as `ui-only`
 * outcomes for the renderer to surface.
 *
 * Per-file algorithm:
 *
 *   1. Read existing content (empty string when the file doesn't
 *      exist; we create it on first install).
 *   2. Look for the BEGIN..END marker block.
 *   3. If not present, append the fresh block + return `installed`.
 *   4. If present and the inner content is byte-identical to the
 *      current persona snippet (after trimming surrounding
 *      whitespace), no-op + return `already-current`.
 *   5. Otherwise, splice the existing block out and append the
 *      new one + return `updated` (with the previous version
 *      tag if one was found).
 */
export async function installPersona(opts: {
  readonly targets: readonly PersonaTarget[];
  readonly personaContent: string;
  readonly version: string;
}): Promise<readonly PersonaInstallResult[]> {
  const { targets, personaContent, version } = opts;
  const results: PersonaInstallResult[] = [];
  const block = buildBlock(personaContent, version);

  for (const target of targets) {
    if (target.kind === 'ui') {
      results.push({
        clientId: target.clientId,
        displayName: target.displayName,
        outcome: { kind: 'ui-only', displayName: target.displayName, uiPath: target.uiPath },
      });
      continue;
    }

    const filePath = target.path;
    try {
      // Ensure the parent directory exists. Owner-only perms
      // because the file may carry persona content the user
      // considers private (preferences, project names, etc.).
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const existing = existsSync(filePath) ? await readFile(filePath, 'utf8') : '';
      const match = existing.match(PERSONA_BLOCK_PATTERN);

      if (match === null) {
        const next = existing.length === 0 ? block.trimStart() : `${existing.trimEnd()}\n${block}`;
        await writeFile(filePath, next, { encoding: 'utf8', mode: 0o600 });
        results.push({
          clientId: target.clientId,
          displayName: target.displayName,
          outcome: { kind: 'installed', target: filePath },
        });
        continue;
      }

      // Existing block found. Check whether content matches the
      // fresh snippet (post-trim). Compare the inner persona
      // text rather than the wrapped block so a version-stamp
      // bump alone isn't enough to call it "updated".
      const previousVersion = match[1] ?? null;
      const existingInner = innerContent(match[0]);
      if (existingInner === personaContent.trim()) {
        results.push({
          clientId: target.clientId,
          displayName: target.displayName,
          outcome: { kind: 'already-current', target: filePath },
        });
        continue;
      }

      // Content drift — splice out the old block, append the new
      // one. The PERSONA_BLOCK_PATTERN matches the leading
      // blank-line separator, so replacing with empty string
      // collapses accumulated blanks.
      const without = existing.replace(PERSONA_BLOCK_PATTERN, '');
      const next = `${without.trimEnd()}\n${block}`;
      await writeFile(filePath, next, { encoding: 'utf8', mode: 0o600 });
      results.push({
        clientId: target.clientId,
        displayName: target.displayName,
        outcome: { kind: 'updated', target: filePath, previousVersion },
      });
    } catch (cause) {
      results.push({
        clientId: target.clientId,
        displayName: target.displayName,
        outcome: { kind: 'failed', target: filePath, message: describe(cause) },
      });
    }
  }

  return results;
}

/**
 * Extract the persona snippet text from a marker-wrapped block
 * (BEGIN..END inclusive). Strips the comment lines + surrounding
 * blank-line separators so the result can be compared with the
 * fresh `personaContent.trim()` for byte equality.
 */
function innerContent(block: string): string {
  // Drop the BEGIN line and everything before it. Version
  // capture is lazy non-whitespace to mirror PERSONA_BLOCK_PATTERN
  // so the same tolerance applies (hyphens, dots, etc. allowed
  // in the stamp).
  const afterBegin = block.replace(
    /^[\s\S]*?<!-- memento:persona BEGIN(?:\s+v\S+?)?\s*-->\s*\n/u,
    '',
  );
  // Drop the END line and everything after it.
  const beforeEnd = afterBegin.replace(/\n<!-- memento:persona END -->[\s\S]*$/u, '');
  return beforeEnd.trim();
}

/**
 * Uninstall the persona snippet from every file-based target.
 * Strips the BEGIN..END range; leaves all other content
 * untouched. Files we never wrote (no marker block) are no-ops.
 *
 * Intentionally does not delete files — even if the auto-
 * installed block was the entire contents, removing only the
 * block (and leaving an empty file) is safer than `unlink`-ing
 * something a user might have begun to author themselves.
 */
export async function uninstallPersona(opts: {
  readonly targets: readonly PersonaTarget[];
}): Promise<readonly PersonaInstallResult[]> {
  const results: PersonaInstallResult[] = [];
  for (const target of opts.targets) {
    if (target.kind === 'ui') {
      results.push({
        clientId: target.clientId,
        displayName: target.displayName,
        outcome: { kind: 'ui-only', displayName: target.displayName, uiPath: target.uiPath },
      });
      continue;
    }
    const filePath = target.path;
    try {
      if (!existsSync(filePath)) {
        results.push({
          clientId: target.clientId,
          displayName: target.displayName,
          outcome: { kind: 'already-current', target: filePath },
        });
        continue;
      }
      const existing = await readFile(filePath, 'utf8');
      if (!PERSONA_BLOCK_PATTERN.test(existing)) {
        results.push({
          clientId: target.clientId,
          displayName: target.displayName,
          outcome: { kind: 'already-current', target: filePath },
        });
        continue;
      }
      const stripped = existing.replace(PERSONA_BLOCK_PATTERN, '');
      const next = stripped.trimEnd() + (stripped.length === 0 ? '' : '\n');
      await writeFile(filePath, next, { encoding: 'utf8', mode: 0o600 });
      results.push({
        clientId: target.clientId,
        displayName: target.displayName,
        outcome: { kind: 'updated', target: filePath, previousVersion: null },
      });
    } catch (cause) {
      results.push({
        clientId: target.clientId,
        displayName: target.displayName,
        outcome: { kind: 'failed', target: filePath, message: describe(cause) },
      });
    }
  }
  return results;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
