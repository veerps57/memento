/**
 * Source of truth for the FAQ section.
 *
 * Imported by `App.tsx` for the visible FAQ block and by the
 * prerender script (via `entry-server.tsx`) to generate the
 * matching FAQPage JSON-LD. Visible answers and structured-data
 * answers must agree; keep them in one place.
 *
 * Plain text only — no inline links or markup. Schema.org's
 * `Question.acceptedAnswer.text` expects plain text, and the
 * visible block renders with `whitespace-pre-line`, so newlines
 * are preserved across both surfaces.
 */
export type FaqItem = {
  readonly question: string;
  readonly answer: string;
};

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: 'What is Memento?',
    answer:
      'Memento is a local-first, LLM-agnostic memory layer for AI assistants. It runs as an MCP server over a single SQLite file on your machine, so any MCP-capable AI assistant — Claude Code, Claude Desktop, Cursor, GitHub Copilot, Cline, OpenCode, Aider, custom agents — can read and write durable, structured memory about you, your work, and your decisions.',
  },
  {
    question: 'How is Memento different from ChatGPT Memory or Claude Projects?',
    answer:
      "ChatGPT Memory and Claude Projects are vendor-specific — your memory is locked to one model and one company. Memento is local-first and tool-agnostic: the same memory store backs every AI assistant you use, you own the SQLite file, and there's no vendor lock-in. The data model is also richer (typed kinds, scopes, decay, append-only audit log), so the assistant can reason about what's still true rather than just retrieving text blobs.",
  },
  {
    question: 'Where is my data stored?',
    answer:
      'In a single SQLite file under your home directory. By default, that is the XDG data directory ($XDG_DATA_HOME/memento/memento.db, typically ~/.local/share/memento/memento.db on POSIX systems). No cloud, no telemetry, no outbound network calls by default. Override the path with --db or the MEMENTO_DB environment variable.',
  },
  {
    question: 'Does Memento work offline?',
    answer:
      'Yes. The MCP server runs entirely on your machine. LLM calls happen between your AI client and your model provider; Memento itself never reaches the internet. Optional vector retrieval uses a model that runs locally too.',
  },
  {
    question: 'Does it cost anything?',
    answer:
      'No. Memento is Apache-2.0 licensed and free to use. Install with npx @psraghuveer/memento init.',
  },
  {
    question: 'Which AI assistants does Memento support?',
    answer:
      'Any MCP-capable client. Tested with Claude Desktop, Claude Code, Cursor, GitHub Copilot, Cline, OpenCode, Aider, and the Anthropic Agent SDK. New MCP-capable clients work without code changes — Memento exposes standard MCP tools and the client decides when to call them.',
  },
];
