// `memento uninstall` — print the manual teardown instructions.
//
// We don't actually delete anything: the user's MCP client
// configs are theirs, and the database may hold memories they
// want to back up before discarding. Instead, the command emits
// a structured snapshot of "files you may want to remove" so
// the user (or their orchestrator) can execute the cleanup
// themselves.
//
// The path list mirrors `init-clients.ts` so the two surfaces
// stay in lockstep — anywhere we know to write a snippet, we
// know where to suggest removing one.

import path from 'node:path';

import { type Result, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

export interface UninstallEntry {
  readonly label: string;
  readonly path: string;
  readonly action: string;
}

export interface UninstallSnapshot {
  readonly version: string;
  readonly entries: readonly UninstallEntry[];
}

export const uninstallCommand: LifecycleCommand = {
  name: 'uninstall',
  description: 'Print teardown instructions (config paths and database location)',
  run: runUninstall,
};

export async function runUninstall(
  _deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<UninstallSnapshot>> {
  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
  const home = process.env['HOME'] ?? '~';
  const dbAbs = input.env.dbPath === ':memory:' ? input.env.dbPath : path.resolve(input.env.dbPath);
  const entries: UninstallEntry[] = [
    {
      label: 'Database',
      path: dbAbs,
      action:
        dbAbs === ':memory:'
          ? 'in-memory; nothing to remove'
          : 'remove this file (consider `memento backup` first to keep a copy)',
    },
    {
      label: 'Claude Code (user scope)',
      path: `${home}/.claude.json`,
      action: 'remove the `mcpServers.memento` entry, or run `claude mcp remove memento`',
    },
    {
      label: 'Claude Code (project scope)',
      path: '.mcp.json (in any project that uses memento)',
      action: 'remove the `mcpServers.memento` entry',
    },
    {
      label: 'Claude Desktop',
      path: 'platform-specific (see `memento init` output for path)',
      action: 'remove the `mcpServers.memento` entry',
    },
    {
      label: 'Cursor',
      path: `${home}/.cursor/mcp.json`,
      action: 'remove the `mcpServers.memento` entry',
    },
    {
      label: 'VS Code',
      path: '.vscode/mcp.json or user mcp.json',
      action: 'remove the `servers.memento` entry',
    },
    {
      label: 'OpenCode',
      path: `${home}/.config/opencode/opencode.json`,
      action: 'remove the `mcp.memento` entry',
    },
    {
      label: 'Package',
      path: 'global npm install',
      action: 'npm uninstall -g @psraghuveer/memento',
    },
  ];
  return ok({ version: resolveVersion(), entries });
}
