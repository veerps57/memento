// `memento completions <shell>` — emit a shell completion script.
//
// We support bash, zsh, and fish. Each script statically lists
// the top-level subcommands; per-namespace verbs are registry-
// driven and the user can introspect them via `memento --help`,
// so we keep completion to the headline surface rather than
// trying to mirror every dotted command.

import { type Result, err, ok } from '@psraghuveer/memento-schema';

import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

export interface CompletionsSnapshot {
  readonly shell: 'bash' | 'zsh' | 'fish';
  readonly script: string;
}

export const completionsCommand: LifecycleCommand = {
  name: 'completions',
  description: 'Emit a shell completion script (bash, zsh, or fish)',
  run: runCompletions,
};

const TOP_LEVEL = [
  'serve',
  'context',
  'doctor',
  'export',
  'import',
  'init',
  'status',
  'ping',
  'uninstall',
  'backup',
  'completions',
  'explain',
  'memory',
  'config',
  'conflict',
  'embedding',
  'compact',
  'search',
  'list',
  'read',
  'forget',
  'get',
  '--help',
  '--version',
  '--format',
  '--db',
];

export async function runCompletions(
  _deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<CompletionsSnapshot>> {
  if (input.subargs.length === 0) {
    return err({
      code: 'INVALID_INPUT',
      message:
        'completions requires a shell argument: bash | zsh | fish (e.g. `memento completions zsh`)',
    });
  }
  const shell = input.subargs[0];
  if (shell === 'bash') return ok({ shell, script: bashScript() });
  if (shell === 'zsh') return ok({ shell, script: zshScript() });
  if (shell === 'fish') return ok({ shell, script: fishScript() });
  return err({
    code: 'INVALID_INPUT',
    message: `unsupported shell '${shell}'. Supported: bash, zsh, fish`,
  });
}

function bashScript(): string {
  const words = TOP_LEVEL.join(' ');
  return [
    '# memento bash completion',
    '# Install: `memento completions bash > /usr/local/etc/bash_completion.d/memento`',
    '_memento_complete() {',
    '  local cur',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )`,
    '  return 0',
    '}',
    'complete -F _memento_complete memento',
    '',
  ].join('\n');
}

function zshScript(): string {
  const words = TOP_LEVEL.join(' ');
  return [
    '#compdef memento',
    '# memento zsh completion',
    '# Install: place this file as `_memento` in a directory on $fpath.',
    '_memento() {',
    `  local -a opts; opts=(${words})`,
    '  _describe "memento" opts',
    '}',
    '_memento "$@"',
    '',
  ].join('\n');
}

function fishScript(): string {
  return [
    '# memento fish completion',
    '# Install: `memento completions fish > ~/.config/fish/completions/memento.fish`',
    ...TOP_LEVEL.map((w) => `complete -c memento -f -a '${w}'`),
    '',
  ].join('\n');
}
