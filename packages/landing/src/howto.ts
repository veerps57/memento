// Install procedure as data.
//
// Single source of truth shared by:
//   1. The visible Quickstart section in App.tsx (rendered as cards).
//   2. The HowTo JSON-LD block injected at build time by
//      scripts/prerender.mjs (cited by AI search engines for
//      "how do I install Memento" type queries).
//
// Keep prose tight and declarative — these strings end up in the
// `text` field of HowToStep nodes and are surfaced verbatim by
// some AI answer engines. Each step's `text` should stand alone
// without surrounding context.
//
// The visible Quickstart in App.tsx uses richer JSX than this
// (a JSON snippet preview for step 2, a separate persona-snippet
// block, etc.). Those are presentation details and don't belong
// in the HowTo schema. The schema describes the procedure; the
// React component decorates it.

export interface HowToStep {
  readonly name: string;
  readonly text: string;
  /** Optional copy-paste command rendered visibly. Becomes
   *  HowToStep.itemListElement[*].text in the schema if present. */
  readonly command?: string;
}

export const HOWTO: {
  readonly name: string;
  readonly description: string;
  readonly totalTime: string;
  readonly steps: ReadonlyArray<HowToStep>;
} = {
  name: 'Install Memento',
  description:
    'Install Memento on your machine in three steps: initialize the database, connect your AI client over MCP, and teach the assistant when to use Memento via the bundled skill or persona snippet.',
  // ISO-8601 duration. ~5 minutes end-to-end on a warm npx cache.
  totalTime: 'PT5M',
  steps: [
    {
      name: 'Initialize Memento',
      text: 'Run `npx @psraghuveer/memento init` in a terminal. This creates the SQLite database under the XDG data directory (typically ~/.local/share/memento/memento.db on POSIX), runs migrations, and prints copy-paste MCP-server snippets for every supported client. The command is idempotent — re-run it any time to reprint the snippets.',
      command: 'npx @psraghuveer/memento init',
    },
    {
      name: 'Connect your AI client',
      text: "Paste the MCP-server snippet that init printed for your client into that client's MCP config (Claude Desktop's claude_desktop_config.json, Cursor's mcp.json, Cline's settings, OpenCode's config, VS Code Agent's mcp.json), or run the one-line subcommand init prints for Claude Code. Then restart the client so it loads the new MCP server.",
    },
    {
      name: 'Install the Memento skill (or paste the persona)',
      text: "If your client loads Anthropic-format skills, copy the bundled Memento skill into ~/.claude/skills/ — most skill-capable clients read from there. (A few use a client-specific path; check your client's skill docs.) If your client doesn't load skills, copy the persona snippet from teach-your-assistant.md into your client's persona file. The skill or persona is what tells the assistant when to call Memento's MCP tools — without it, the assistant has the tools but no instinct to use them.",
      command: 'cp -R "$(npx -y @psraghuveer/memento skill-path)" ~/.claude/skills/',
    },
  ],
};
