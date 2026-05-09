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
  {
    question: 'Does Memento send my data anywhere?',
    answer:
      'No. Memento makes no outbound network calls by default. The MCP server runs entirely on your machine, the SQLite file lives in your home directory, and the embeddings model used for vector retrieval is downloaded once on first use and runs locally. Your AI client talks to its model provider as it always does — Memento sits between the client and your local memory store, never between you and your model provider.',
  },
  {
    question: 'Can I use the same Memento store across multiple machines?',
    answer:
      "Memento doesn't sync. The store is a single SQLite file under your home directory; you can copy or symlink it across machines through whatever sync layer you already use (iCloud, Dropbox, Syncthing, rsync, a shared NFS mount). Two machines writing at the same time can corrupt the SQLite WAL — most users keep one primary machine and treat sync as an explicit copy step. For multi-machine workflows, the JSONL export/import is safer than file-level sync.",
  },
  {
    question: 'What happens to my memory if I switch AI tools?',
    answer:
      'Nothing — the memory stays in your SQLite file. Memento exposes the same MCP server to every client, so switching from Claude Code to Cursor to OpenCode is just pointing the new client at the existing Memento server. Memories are never moved or transformed; the new client reads the same store.',
  },
  {
    question: 'How do I back up or migrate my memory?',
    answer:
      'Two options. (1) Copy the SQLite file directly: cp ~/.local/share/memento/memento.db backup.db — the file is fully self-contained. (2) Use the portable JSONL export: npx @psraghuveer/memento export > memories.jsonl, then npx @psraghuveer/memento import < memories.jsonl on the target machine. The JSONL is human-readable and version-controllable; the format is documented in ADR-0013 and stable across versions.',
  },
  {
    question: 'Does Memento work with custom or self-built MCP clients?',
    answer:
      "Yes. Memento exposes the standard MCP protocol over stdio — any client that speaks MCP can talk to it. Build a custom agent with the Anthropic Agent SDK, the OpenAI Agents SDK, a LangChain wrapper, a Python script using mcp-python, or any other MCP-compatible runtime, and point it at npx @psraghuveer/memento serve. No code changes on Memento's side are needed for new client types.",
  },
];
