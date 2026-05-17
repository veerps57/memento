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
    'Install Memento on your machine in two steps: run init (interactive on a TTY — sets your name, installs the skill, seeds a starter pack), then paste the printed MCP-server snippet into your AI client and restart it. The session-start teaching spine ships with the MCP server and is picked up by clients that honour the field; the bundled skill and the optional persona snippet cover the gap for clients that ignore it.',
  // ISO-8601 duration. ~3 minutes end-to-end on a warm npx cache.
  totalTime: 'PT3M',
  steps: [
    {
      name: 'Initialize Memento (interactive)',
      text: "Run `npx @psraghuveer/memento init` in a terminal. On a TTY, init walks you through three one-keystroke setup questions: your preferred display name (so memories read 'Raghu prefers …' instead of 'The user prefers …'), whether to install the bundled Memento skill into ~/.claude/skills/, and whether to seed your store with one of four starter packs (engineering-simplicity, pragmatic-programmer, twelve-factor-app, google-sre). Then it prints copy-paste MCP-server snippets for every supported client. Idempotent — re-run any time. Pass --no-prompt to suppress the interactive flow for CI / scripts.",
      command: 'npx @psraghuveer/memento init',
    },
    {
      name: 'Connect your AI client',
      text: "Paste the MCP-server snippet that init printed for your client into that client's MCP config (Claude Desktop's claude_desktop_config.json, Cursor's mcp.json, Cline's settings, OpenCode's config, VS Code Agent's mcp.json), or run the one-line subcommand init prints for Claude Code. Then restart the client so it loads the new MCP server. The session-start teaching spine — when to load context, when to write, when to confirm, the topic:value rule for preferences — ships with the server (ADR-0026). Clients that honour the optional `instructions` field (Claude Code, Claude Desktop) inject the spine into the assistant's system prompt; clients that ignore it (Claude Chat web today) fall back to schema-embedded session-start hints or the persona snippet you paste into the client's custom-instructions slot. Verify your assistant can round-trip a write/search end-to-end with `npx @psraghuveer/memento verify-setup`.",
      command: 'npx @psraghuveer/memento verify-setup',
    },
  ],
};
