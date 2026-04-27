// Renders `docs/reference/cli.md` from the command registry.
//
// The CLI surface mirrors the MCP surface: every command with
// `'cli'` in its `surfaces` set is reachable as `memento <name>`
// (the dotted command name is the CLI subcommand path, with `.`
// rendered as a space — `memory.write` → `memento memory write`).
//
// Lifecycle commands (`serve`, `context`, `store migrate`) live
// outside the registry — they don't fit `AnyCommand`'s schema-
// driven shape. The doc renders them as a separate section that
// the caller passes in (`@psraghuveer/memento` owns their definitions);
// this keeps the doc covering every reachable subcommand without
// a circular dep from `@psraghuveer/memento-core` to `@psraghuveer/memento`.
//
// We also render a fixed Global Flags section that mirrors
// `@psraghuveer/memento`'s `renderHelp`. The CLI's flag parser is the
// source of truth; the renderer hard-codes the table because the
// parser doesn't expose a machine-readable description today.
//
// Like the MCP renderer, we don't project Zod input schemas into
// flag tables in this first pass. Once per-command flag wiring
// becomes introspectable, the renderer can pick it up.

import type { AnyCommand, CommandSideEffect } from '../commands/types.js';
import { renderHeader, sortByName } from './shared.js';

const SIDE_EFFECT_BLURB: Record<CommandSideEffect, string> = {
  read: 'Pure read; safe to call freely.',
  write: 'Mutates state and emits an audit-log event.',
  destructive: 'Bulk or irreversible; the CLI requires `--confirm` to execute.',
  admin: 'Operational / introspection.',
};

/**
 * A lifecycle command entry, projected from `@psraghuveer/memento`'s
 * `LIFECYCLE_COMMANDS` map. The renderer takes the minimum it
 * needs (name + description) so the type does not pull in CLI
 * runtime types and so tests can construct fixtures inline.
 *
 * `name` is the lifecycle name as the user types it: dots become
 * spaces, just like registry command names (`store.migrate` →
 * `memento store migrate`).
 */
export interface LifecycleDocEntry {
  readonly name: string;
  readonly description: string;
}

const GLOBAL_FLAGS: ReadonlyArray<{
  readonly flag: string;
  readonly description: string;
}> = [
  {
    flag: '--db <path>',
    description:
      'Database path. Env: `MEMENTO_DB`. Default: `$XDG_DATA_HOME/memento/memento.db` (POSIX: `~/.local/share/memento/memento.db`; Windows: `%LOCALAPPDATA%\\memento\\memento.db`).',
  },
  {
    flag: '--format json\\|text\\|auto',
    description:
      'Output format. Env: `MEMENTO_FORMAT`. Default: `auto` (json on a pipe, text on a tty).',
  },
  {
    flag: '--debug',
    description: 'Print stack traces for unhandled errors.',
  },
  {
    flag: '--version, -V',
    description: 'Print the memento version and exit.',
  },
  {
    flag: '--help, -h',
    description: 'Print help and exit.',
  },
];

function commandPath(name: string): string {
  return `memento ${name.split('.').join(' ')}`;
}

/**
 * Hand-curated example output blocks attached to specific
 * lifecycle commands. Lifecycle commands don't carry I/O
 * schemas the way registry commands do, so we can't
 * auto-generate sample output the way `mcp-tools.md` derives
 * from each command's input schema. The single command worth a
 * worked example today is `context`: it's the canonical
 * "what does my install look like?" entry point for both human
 * operators and AI agents, and the JSON shape is stable enough
 * to print verbatim. `doctor` gets the same treatment for the
 * same reasons: it is the canonical "is something wrong?" entry
 * point, and a bug report should always paste its output.
 */
const LIFECYCLE_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  context: [
    '**Example.** Print a JSON snapshot of the running CLI:',
    '',
    '```bash',
    'memento --db /tmp/example.db --format json context',
    '```',
    '',
    'The response is a `Result` envelope. On success, `value` carries the version, the resolved DB path, every registered command (with its surface set and side-effect class), and a snapshot of every config key. Truncated for readability:',
    '',
    '```json',
    '{',
    '  "ok": true,',
    '  "value": {',
    '    "version": "0.1.0",',
    '    "dbPath": "/tmp/example.db",',
    '    "registry": {',
    '      "commands": [',
    '        {',
    '          "name": "memory.write",',
    '          "sideEffect": "write",',
    '          "surfaces": ["mcp", "cli"],',
    '          "description": "Create a new memory in the given scope."',
    '        }',
    '      ]',
    '    },',
    '    "config": {',
    '      "retrieval.vector.enabled": false,',
    '      "embedder.local.model": "bge-small-en-v1.5",',
    '      "embedder.local.dimension": 384',
    '    }',
    '  }',
    '}',
    '```',
    '',
    'The full snapshot lists every command in the registry and every key in the config schema. `--format text` pretty-prints the same JSON; `--format auto` (the default) chooses based on whether stdout is a TTY.',
  ],
  doctor: [
    '**Example.** Verify a fresh install:',
    '',
    '```bash',
    'memento --db /tmp/example.db --format json doctor',
    '```',
    '',
    'The response is a `Result` envelope. On success, `value.checks` reports one entry per check (Node version, DB path, database open, embedder peer dep) with a stable `name`, a boolean `ok`, and a human-readable `message`. On failure, the same array ships in `error.details` so a bug report can include the full diagnostic without rerunning. DB-class failures map to `STORAGE_ERROR` (exit 5); other failures map to `CONFIG_ERROR` (exit 4).',
  ],
};

function sortLifecycle(entries: readonly LifecycleDocEntry[]): readonly LifecycleDocEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function renderCliDoc(
  commands: readonly AnyCommand[],
  lifecycle: readonly LifecycleDocEntry[] = [],
): string {
  const cli = sortByName(commands.filter((c) => c.surfaces.includes('cli')));
  const life = sortLifecycle(lifecycle);
  const lines: string[] = [];
  lines.push(
    renderHeader('CLI Reference', '@psraghuveer/memento-core/commands', [
      'Every command in the registry whose `surfaces` set includes `cli` is reachable through the `memento` binary.',
      'The dotted command name maps to the subcommand path: `memory.write` is invoked as `memento memory write`.',
      'Argument and flag definitions live in source; this reference lists invocations, descriptions, and side-effect class.',
    ]),
  );
  lines.push('');
  lines.push('## Invocation');
  lines.push('');
  lines.push('```text');
  lines.push('memento [<global-flags>] <command> [<args>]');
  lines.push('```');
  lines.push('');
  lines.push(
    'Global flags must appear **before** the subcommand. Registry commands read structured input via `--input <json>`, `--input @file`, `--input -` (stdin), or no flag at all (defaults to `{}`).',
  );
  lines.push('');
  lines.push('## Global flags');
  lines.push('');
  lines.push('| Flag | Description |');
  lines.push('| --- | --- |');
  for (const entry of GLOBAL_FLAGS) {
    lines.push(`| \`${entry.flag}\` | ${entry.description} |`);
  }
  lines.push('');
  lines.push('## Lifecycle commands');
  lines.push('');
  lines.push(
    'Lifecycle commands sit outside the registry. They manage the CLI process itself (database initialization, MCP transport, runtime introspection) and do not have input/output schemas.',
  );
  lines.push('');
  if (life.length === 0) {
    lines.push('_(none registered)_');
    lines.push('');
  } else {
    for (const entry of life) {
      lines.push(`### \`${commandPath(entry.name)}\``);
      lines.push('');
      lines.push(entry.description);
      lines.push('');
      const example = LIFECYCLE_EXAMPLES[entry.name];
      if (example !== undefined) {
        lines.push(...example);
        lines.push('');
      }
    }
  }
  lines.push('## Registry commands');
  lines.push('');
  lines.push(`Total: ${cli.length} command${cli.length === 1 ? '' : 's'}.`);
  lines.push('');
  for (const cmd of cli) {
    lines.push(`### \`${commandPath(cmd.name)}\``);
    lines.push('');
    lines.push(cmd.metadata.description);
    if (cmd.metadata.longDescription !== undefined) {
      lines.push('');
      lines.push(cmd.metadata.longDescription);
    }
    lines.push('');
    lines.push(`- **Side-effect:** \`${cmd.sideEffect}\` — ${SIDE_EFFECT_BLURB[cmd.sideEffect]}`);
    if (cmd.metadata.since !== undefined && cmd.metadata.since !== '') {
      lines.push(`- **Since:** ${cmd.metadata.since}`);
    }
    if (cmd.metadata.deprecated !== undefined) {
      lines.push(`- **Deprecated:** ${cmd.metadata.deprecated}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
