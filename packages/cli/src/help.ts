// `memento --help` body.
//
// Help text is owned here, not co-located with `argv.ts`,
// because we want one place to keep the prose tidy and one
// place for `docs:check` to compare against generated reference
// docs in subsequent commits (#26.6 will pull lifecycle command
// metadata from a single source of truth and assert this string
// stays in sync).

export function renderHelp(topic?: string): string {
  if (topic !== undefined && topic.length > 0) {
    const focused = renderTopicHelp(topic);
    if (focused !== undefined) return focused;
    // Unknown topic falls through to the index. We deliberately
    // don't surface an error: `memento <bogus> --help` is a more
    // user-friendly default than a hard failure.
  }
  return [
    'Usage: memento [<global-flags>] <command> [<args>]',
    '',
    'Lifecycle commands:',
    '  init               Initialise the database and print MCP client setup snippets',
    '  serve              Run the MCP server over stdio',
    '  dashboard          Launch the local web dashboard (browser UI; ADR-0018)',
    '  context            Print runtime context (db, version, registered commands)',
    '  doctor             Run diagnostic checks (node version, db, peer deps; --quick, --mcp)',
    '  status             One-screen summary (counts, last event, db size)',
    '  ping               Spawn `serve` and round-trip an MCP tools/list call',
    '  backup             Point-in-time copy of the database (uses VACUUM INTO)',
    '  uninstall          Print teardown instructions (does not delete anything)',
    '  completions        Emit a shell completion script (bash, zsh, fish)',
    '  explain <code>     Look up an error code in the catalogue',
    '  store migrate      Run pending database migrations',
    '  export             Export the database to a portable JSONL artefact (ADR-0013)',
    '  import             Import a portable JSONL artefact into the database',
    '',
    'Registry shortcuts (single-token sugar):',
    '  search <query>     memory.search',
    '  list               memory.list',
    '  read <id>          memory.read',
    '  forget <id>        memory.forget',
    '  get <key>          config.get',
    '',
    'Registry commands:',
    "  <namespace> <verb>      Run a registered command (e.g. 'memento memory write')",
    "  <namespace>.<verb>      Same, dotted form (e.g. 'memento memory.write')",
    '  Input is read from --input <json>, --input @file, or stdin via --input -',
    '  See docs/reference/cli.md for the full registry.',
    '  See `memento --help <topic>` for namespace help (memory, config, conflict, embedding, compact).',
    '',
    'Global flags:',
    '  --db <path>                 Database path (env: MEMENTO_DB; default: XDG data dir, e.g. ~/.local/share/memento/memento.db)',
    '  --format json|text|auto     Output format (env: MEMENTO_FORMAT; default: auto)',
    '  --debug                     Print stack traces for unhandled errors',
    '  --version, -V               Print the memento version and exit',
    '  --help, -h                  Print this help and exit',
    '',
  ].join('\n');
}

const TOPIC_HELP: Record<string, readonly string[]> = {
  memory: [
    'memento memory <verb>',
    '',
    'Verbs (see `docs/reference/cli.md` for full schemas):',
    '  write              Persist a new memory.',
    '  read               Fetch a single memory by id.',
    '  list               List active memories (filterable by scope/kind/tag).',
    '  search             Hybrid keyword + vector retrieval.',
    '  confirm            Bump `last_confirmed_at` on an existing memory.',
    '  update             Patch a memory (creates a `superseded`-chain entry).',
    '  forget             Mark a memory `forgotten` (logical delete).',
    '  restore            Un-forget a memory.',
    '',
    'Single-token sugar (positional):',
    '  memento search "<query>"',
    '  memento list',
    '  memento read <id>',
    '  memento forget <id>',
  ],
  config: [
    'memento config <verb>',
    '',
    'Verbs:',
    '  get <key>          Read a config value (returns the effective value).',
    '  set <key> <value>  Persist a config event.',
    '  list               Enumerate every config key with its effective value.',
    '',
    'Single-token sugar:',
    '  memento get <key>',
  ],
  conflict: [
    'memento conflict <verb>',
    '',
    'Verbs:',
    '  list               Enumerate open conflicts.',
    '  resolve            Resolve a conflict (accept-new | accept-existing | supersede | ignore).',
    '',
    'See docs/guides/conflicts.md for the full workflow.',
  ],
  embedding: [
    'memento embedding <verb>',
    '',
    'Verbs:',
    '  rebuild            Re-embed every active memory (e.g. after switching providers).',
    '',
    'Requires `retrieval.vector.enabled = true` and a resolvable embedder package.',
  ],
  compact: [
    'memento compact <verb>',
    '',
    'Verbs:',
    '  preview            Dry-run a compaction pass (returns merge candidates).',
    '  run                Apply a compaction pass.',
    '',
    'See docs/guides/operations.md for scheduling guidance.',
  ],
};

function renderTopicHelp(topic: string): string | undefined {
  const lines = TOPIC_HELP[topic.toLowerCase()];
  if (lines === undefined) return undefined;
  return `${lines.join('\n')}\n`;
}
