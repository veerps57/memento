// MCP tool name derivation (ADR-0010).
//
// The command registry uses dotted `noun.verb` names
// (`memory.read`, `config.set`) because the CLI surface splits
// them into subcommand paths (`memento memory read`). The MCP
// surface wants the opposite shape: snake_case `verb_noun`
// (`read_memory`), to match the prevailing convention used by
// Anthropic's reference servers (`read_file`, `write_file`,
// `create_issue`, `search_repositories`). LLMs call tools more
// reliably when names match the convention they were trained on.
//
// Default rule: `noun.verb` → `verb_noun`. `noun` and `verb` are
// already lower-case in the registry, so no case folding is
// needed. Commands whose default reads awkwardly (collections
// wanting a plural, event feeds wanting `list_*`) declare
// `metadata.mcpName` explicitly.
//
// The transform is intentionally trivial — anything more
// elaborate (heuristic pluralisation, irregular forms) belongs
// in `mcpName` overrides where the choice is visible to grep.

import type { AnyCommand } from './types.js';

/**
 * Resolve the MCP tool name for a command. Honors
 * `metadata.mcpName` when set; otherwise applies the default
 * `verb_noun` transform.
 *
 * @throws if the registry name is not in `noun.verb` form when
 *         no override is supplied. The registry already pins
 *         this shape — this guard catches future drift.
 */
export function deriveMcpName(command: Pick<AnyCommand, 'name' | 'metadata'>): string {
  if (command.metadata.mcpName !== undefined) {
    return command.metadata.mcpName;
  }
  return defaultMcpName(command.name);
}

/**
 * Apply the default `noun.verb` → `verb_noun` transform.
 * Exported for the unit test; production code should call
 * {@link deriveMcpName}.
 */
export function defaultMcpName(registryName: string): string {
  const dot = registryName.indexOf('.');
  if (dot === -1 || dot === 0 || dot === registryName.length - 1) {
    throw new Error(
      `deriveMcpName: registry name '${registryName}' is not 'noun.verb'; set metadata.mcpName explicitly.`,
    );
  }
  if (registryName.indexOf('.', dot + 1) !== -1) {
    throw new Error(
      `deriveMcpName: registry name '${registryName}' has more than one '.'; set metadata.mcpName explicitly.`,
    );
  }
  const noun = registryName.slice(0, dot);
  const verb = registryName.slice(dot + 1);
  return `${verb}_${noun}`;
}
