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
    'Install Memento on your machine in three steps: run init (interactive on a TTY — sets your name, installs the skill, seeds a starter pack, and auto-installs the persona snippet into detected AI clients), paste the printed MCP-server snippet into your AI client and restart it, then for UI-only clients paste the persona snippet manually so the teaching contract reaches your assistant on every message.',
  // ISO-8601 duration. ~5 minutes end-to-end on a warm npx cache.
  totalTime: 'PT5M',
  steps: [
    {
      name: 'Run init (interactive)',
      text: "Run `npx @psraghuveer/memento init` in a terminal. On a TTY, init walks you through four one-keystroke setup questions: your preferred display name (so memories read 'Raghu prefers …' instead of 'The user prefers …'); whether to install the bundled Memento skill into ~/.claude/skills/; whether to seed your store with one of four starter packs (engineering-simplicity, pragmatic-programmer, twelve-factor-app, google-sre); and whether to auto-install the persona snippet into the user-scope custom-instructions file of every detected file-based AI client (Claude Code at ~/.claude/CLAUDE.md, OpenCode at ~/.config/opencode/AGENTS.md, Cline at ~/Documents/Cline/Rules/memento.md). Then it prints copy-paste MCP-server snippets for every supported client and the per-client paste instructions for UI-only clients (Cowork, Claude Desktop, Claude Chat, Cursor User Rules). Idempotent — re-run any time. Pass --no-prompt to suppress the interactive flow for CI / scripts.",
      command: 'npx @psraghuveer/memento init',
    },
    {
      name: 'Connect your AI client',
      text: "Paste the MCP-server snippet that init printed into your client's MCP config (the file location varies by client), or run the one-line subcommand init prints where the client ships one. Then restart the client so it loads the new MCP server. Verify the wire end-to-end with `npx @psraghuveer/memento verify-setup` — spawns the server as a subprocess and round-trips a write/search/cleanup through the MCP transport.",
      command: 'npx @psraghuveer/memento verify-setup',
    },
    {
      name: 'Confirm the persona snippet reaches your assistant',
      text: "Memento ships three teaching surfaces — an MCP `instructions` spine on the wire (ADR-0026), a bundled skill for skill-capable clients, and the persona snippet. The MCP spec leaves `instructions` optional on the client side and current implementations vary in whether they surface it; the skill is intent-triggered so it doesn't fire on neutral first messages. The persona snippet is the only surface guaranteed to reach the assistant's system prompt on every message. If you said `Y` to the persona auto-install prompt in step 1, this is already done for every file-based AI client detected on your machine. For UI-only clients (Cowork, Claude Desktop, Claude Chat at claude.ai, Cursor User Rules) and any setup you skipped, paste the snippet from docs/guides/teach-your-assistant.md (also rendered on this page below) into the client's custom-instructions / system-prompt slot.",
    },
  ],
};
