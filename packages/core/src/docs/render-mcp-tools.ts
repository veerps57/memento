// Renders `docs/reference/mcp-tools.md` from the command registry.
//
// The MCP surface exposes every command with `'mcp'` in its
// `surfaces` set as a tool. This renderer projects the registry
// into a stable Markdown document the user can scan for tool
// names, descriptions, side-effect class, and the MCP hint
// overrides each command declares.
//
// Schema rendering is deliberately out of scope for this first
// generator pass — input/output Zod schemas are the source of
// truth and would need a faithful markdown projection to be
// useful (the alternative is a half-truth that drifts from the
// runtime). The README in `docs/reference/` flags this.

import { deriveMcpName } from '../commands/mcp-name.js';
import type { AnyCommand, CommandSideEffect } from '../commands/types.js';
import { renderHeader, sortByName } from './shared.js';

const SIDE_EFFECT_BLURB: Record<CommandSideEffect, string> = {
  read: 'Pure read; safe to call freely.',
  write: 'Mutates state and emits an audit-log event.',
  destructive: 'Bulk or irreversible; clients should confirm before invoking.',
  admin: 'Operational / introspection; not part of the data plane.',
};

export function renderMcpToolsDoc(commands: readonly AnyCommand[]): string {
  const tools = sortByName(commands.filter((c) => c.surfaces.includes('mcp')));
  const lines: string[] = [];
  lines.push(
    renderHeader('MCP Tools', '@psraghuveer/memento-core/commands', [
      'Every command in the registry whose `surfaces` set includes `mcp` is exposed as an MCP tool.',
      'Tool names are `verb_noun` snake_case (per ADR-0010): `read_memory`, `search_memory`, `set_config`. The dotted registry name (`memory.read`) is the CLI subcommand path; the MCP name is derived from it.',
      'Input and output schemas are defined in source as Zod schemas and validated by the adapter on every call;',
      'this reference lists names, descriptions, side-effect class, and the MCP annotation hints each command declares.',
    ]),
  );
  lines.push('');
  lines.push(`Total: ${tools.length} tool${tools.length === 1 ? '' : 's'}.`);
  lines.push('');
  for (const tool of tools) {
    const mcpName = deriveMcpName(tool);
    lines.push(`## \`${mcpName}\``);
    lines.push('');
    lines.push(`Registry name: \`${tool.name}\` — CLI: \`memento ${tool.name.replace('.', ' ')}\``);
    lines.push('');
    lines.push(tool.metadata.description);
    if (tool.metadata.longDescription !== undefined) {
      lines.push('');
      lines.push(tool.metadata.longDescription);
    }
    lines.push('');
    lines.push(`- **Side-effect:** \`${tool.sideEffect}\` — ${SIDE_EFFECT_BLURB[tool.sideEffect]}`);
    if (tool.metadata.since !== undefined && tool.metadata.since !== '') {
      lines.push(`- **Since:** ${tool.metadata.since}`);
    }
    if (tool.metadata.deprecated !== undefined) {
      lines.push(`- **Deprecated:** ${tool.metadata.deprecated}`);
    }
    const hints = tool.metadata.mcp;
    if (hints !== undefined) {
      const parts: string[] = [];
      if (hints.title !== undefined) parts.push(`title=\`${hints.title}\``);
      if (hints.readOnlyHint !== undefined) parts.push(`readOnlyHint=\`${hints.readOnlyHint}\``);
      if (hints.destructiveHint !== undefined)
        parts.push(`destructiveHint=\`${hints.destructiveHint}\``);
      if (hints.idempotentHint !== undefined)
        parts.push(`idempotentHint=\`${hints.idempotentHint}\``);
      if (parts.length > 0) {
        lines.push(`- **MCP hints:** ${parts.join(', ')}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
