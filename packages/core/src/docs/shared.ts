// Shared helpers for the reference-doc renderers.
//
// Each renderer produces a self-contained Markdown string. The
// helpers here keep header formatting and ordering rules
// consistent across files so the generator output is uniform.

import type { AnyCommand } from '../commands/types.js';

/**
 * Standard header rendered at the top of every generated
 * reference doc. The `do-not-edit` admonition is what the
 * `docs:check` gate ultimately enforces — the file on disk must
 * round-trip through the generator without diff.
 *
 * `paragraphs` are the prose body that explains what's in the
 * file. Each entry becomes a separate paragraph (one blank line
 * between).
 */
export function renderHeader(title: string, source: string, paragraphs: string[]): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `> **This file is auto-generated from \`${source}\` via \`pnpm docs:generate\`. Do not edit by hand.**`,
  );
  lines.push('');
  for (let i = 0; i < paragraphs.length; i += 1) {
    lines.push(paragraphs[i] ?? '');
    if (i < paragraphs.length - 1) lines.push('');
  }
  return lines.join('\n');
}

/**
 * Stable ordering for command lists: case-sensitive ascending by
 * name. The registry preserves registration order at runtime,
 * but reference docs are easier to scan alphabetically and the
 * generator output must not depend on registration order or the
 * `docs:check` gate would flake on bootstrap reorderings.
 */
export function sortByName(commands: readonly AnyCommand[]): readonly AnyCommand[] {
  return [...commands].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
