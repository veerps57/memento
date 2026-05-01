# Memento

> A local-first, LLM-agnostic memory layer for AI assistants.

Memento is a small CLI tool that runs an [MCP](https://modelcontextprotocol.io) server over a local SQLite database, so any MCP-capable AI assistant — Claude Desktop, Claude Code, Cursor, GitHub Copilot, Cline, OpenCode, Aider, and others — can read and write durable, structured memory about you, your work, and your decisions.

Your memory lives in one SQLite file on your machine. No outbound network calls by default. No vendor lock-in.

```bash
export MEMENTO_DB=~/.local/share/memento/memento.db
npx @psraghuveer/memento init
```

That's the install story. `init` creates the database, runs migrations, and prints copy-paste MCP snippets for Claude Code, Claude Desktop, Cursor, VS Code Agent mode, and OpenCode. Paste the snippet for your client and you're done.

## Getting started

**Prerequisites.** Node.js ≥ 20.10, and a C/C++ toolchain so `better-sqlite3` can compile on platforms without a prebuild (Xcode command-line tools on macOS, `build-essential` on Debian/Ubuntu).

Run `init` once to set things up:

```bash
export MEMENTO_DB=~/.local/share/memento/memento.db
npx @psraghuveer/memento init
```

To run the server directly (e.g. for debugging):

```bash
npx @psraghuveer/memento serve
```

The server listens on stdio for [MCP](https://modelcontextprotocol.io) requests. To pass extra flags (e.g. a custom database location):

```bash
npx @psraghuveer/memento serve --db ~/.local/share/memento/memento.db
```

You can also point at an existing database with the `MEMENTO_DB` environment variable.

**Verify the install** by running `npx @psraghuveer/memento doctor` (add `--quick` to skip the DB and embedder probes; add `--mcp` to also scan known MCP client config files). To inspect what your install can do — registered commands, current config, database location — without speaking MCP, run `npx @psraghuveer/memento context`. To smoke-test the MCP transport end-to-end, `npx @psraghuveer/memento ping`.

**Wiring Memento into an MCP client** (Claude Desktop, Claude Code, Cursor, Cline, OpenCode, VS Code Agent mode, …) is covered step by step in [docs/guides/mcp-client-setup.md](docs/guides/mcp-client-setup.md). The TL;DR: run `npx @psraghuveer/memento init`, paste the snippet, set `MEMENTO_DB` to a stable absolute path.

**Vector retrieval** (paraphrase matching on top of FTS) is on by default. The first search triggers a one-time model download (~110 MB); after that, both FTS and vector arms run automatically. If the model has not yet downloaded, search degrades gracefully to FTS-only. For configuration options and library-wiring details, see [docs/guides/embeddings.md](docs/guides/embeddings.md).

**Operating the store** day-to-day — `compact`, `backup`, `status`, scheduling — is covered in [docs/guides/operations.md](docs/guides/operations.md). The conflict workflow is in [docs/guides/conflicts.md](docs/guides/conflicts.md). To prime an AI assistant on how to use Memento well, see [docs/guides/teach-your-assistant.md](docs/guides/teach-your-assistant.md).

**Stuck?** Common failure modes (better-sqlite3 build errors, `command not found: memento`, `STORAGE_ERROR`s, embedder peer-dep errors) are covered in [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md).

For the contributor workflow (branching, commit conventions, PR checklist) see [CONTRIBUTING.md](CONTRIBUTING.md). AI agents working on the codebase **must** also read [AGENTS.md](AGENTS.md).

## Why Memento

Every AI session starts the same way: re-explaining your preferences, your project's conventions, the decisions you made last week, the dead-ends to avoid. Each tool solves this in its own siloed way (`CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`, ChatGPT Memory) — but you, the human, are the one constant. Your memory shouldn't fragment across vendors.

Memento is one place where memory lives. Any tool that speaks MCP — a coding assistant, a desktop chat client, a custom agent — can use it.

## Guiding principles

These are the four principles every design decision is judged against. They are documented at length in [ARCHITECTURE.md](ARCHITECTURE.md).

1. **First principles.** Every construct exists because we proved we need it, not because it's how things are usually done.
2. **Modular.** Any component can be replaced without rewriting the rest.
3. **Extensible.** New variants don't require breaking changes.
4. **Config-driven by the user.** Behavior is shaped by configuration, not by code.

## What Memento is

- **Local-first.** Your memory lives in a single SQLite file under your home directory. No outbound network calls by default.
- **LLM-agnostic.** No model dependencies. No proprietary APIs. Works with whatever LLM your tools use.
- **Tool-agnostic.** Exposes its full surface over both MCP (for AI agents) and a CLI (for humans and scripts). The two are kept in lockstep by a single command registry.
- **Privacy-conscious.** A built-in regex-based scrubber strips secrets before they are persisted. Patterns are user-configurable.
- **Auditable.** Every write produces an event in an append-only log. You can answer "why is this memory here?" and "when did this change?" at any time.
- **Versioned.** Schema migrations are append-only. Memories are typed, validated at the boundary, and have explicit lifecycles (active, superseded, forgotten, archived).

## What Memento is not

- Not a chat history store. It records distilled, structured memory — preferences, facts, episodes, lessons — not raw transcripts.
- Not a knowledge graph or semantic database for your codebase. Use the right tools for that.
- Not a cloud service. Memory lives on your machine; cloud embedders, sync across machines, and team-shared memory are not part of the product.
- Not a plugin platform. The architecture leaves the door open, but Memento ships with a fixed surface to hold the line on quality.

The full list of out-of-scope and current limitations is in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## How it fits together

```text
┌─────────────────────────────────────────────────────────┐
│  Clients: Claude Code, Cursor, Copilot, OpenCode, …     │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP (stdio)
┌──────────────────────▼──────────────────────────────────┐
│  memento-server (MCP adapter)                           │
└──────────────────────┬──────────────────────────────────┘
                       │ Command registry
┌──────────────────────▼──────────────────────────────────┐
│  memento-core: services, scope resolver, scrubber,      │
│                conflict detector, decay engine          │
└──────────────────────┬──────────────────────────────────┘
                       │ Repository interfaces
┌──────────────────────▼──────────────────────────────────┐
│  SQLite (better-sqlite3) + FTS5 + optional sqlite-vec   │
└─────────────────────────────────────────────────────────┘
```

A full architectural walkthrough lives in [ARCHITECTURE.md](ARCHITECTURE.md). Each significant decision has an [Architecture Decision Record](docs/adr/).

## For contributors (human or AI)

Contributions are welcome from both human and AI-assisted authors. We treat them with the same standards.

- **Read [AGENTS.md](AGENTS.md)** if you are an AI coding agent or working with one. It is the canonical instruction set; `CLAUDE.md` and `.github/copilot-instructions.md` are thin pointers to it.
- **Read [CONTRIBUTING.md](CONTRIBUTING.md)** for development setup, branching, commit conventions, and the PR lifecycle.
- **Open a [design proposal issue](.github/ISSUE_TEMPLATE/design_proposal.yml)** before any non-trivial change.
- **Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md).** It asks you to justify, not just describe, the change.

We use [GitHub Discussions](https://github.com/veerps57/memento/discussions) for questions and ideas; the [issue tracker](https://github.com/veerps57/memento/issues) is for bugs and accepted work.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.

## Packages

Memento is a small workspace of focused packages. The architecture is documented in [docs/architecture/](docs/architecture/) and the design decisions in [docs/adr/](docs/adr/); both are the source of truth for what Memento does and why.

| Package                                              | Notes                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@psraghuveer/memento-schema`](packages/schema)                 | Memory / event / scope / scrubber / conflict / config / result schemas, plus per-`ConfigKey` value schemas.                                                                                                                                                                                                                                                            |
| [`@psraghuveer/memento-core`](packages/core)                     | Storage and migrations, memory + event repositories, scope resolver, scrubber, decay engine with `compact` archival pass, conflict detection + supersession workflow, embedding hook + bulk re-embed driver, `EmbeddingProvider` interface, FTS + brute-force vector retrieval pipeline + ranker, and the command registry with validating execute path (ADR 0003).    |
| [`@psraghuveer/memento-server`](packages/server)                 | MCP adapter — `buildMementoServer` projects the `@psraghuveer/memento-core` command registry as MCP tools; `serveStdio` wires it to stdio. Used by `memento serve`.                                                                                                                                                                                                                |
| [`@psraghuveer/memento-embedder-local`](packages/embedder-local) | Local `EmbeddingProvider` backed by transformers.js + `bge-base-en-v1.5`. Ships as a regular dependency; lazy single-flight init downloads the model on first use. See ADR [0006](docs/adr/0006-local-embeddings-only-in-v1.md).                                                                                                             |
| [`@psraghuveer/memento`](packages/cli) (CLI)         | The published `memento` binary (`npx @psraghuveer/memento` or `npm i -g @psraghuveer/memento`). Lifecycle commands (`serve`, `context`, `doctor`, `store migrate`) plus a generic projection of the registry surface (`memento <namespace> <verb>`). See [docs/reference/cli.md](docs/reference/cli.md).                                                                              |
