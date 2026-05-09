# @psraghuveer/memento

[![CI](https://github.com/veerps57/memento/actions/workflows/ci.yml/badge.svg)](https://github.com/veerps57/memento/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@psraghuveer/memento)](https://www.npmjs.com/package/@psraghuveer/memento) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/veerps57/memento/blob/main/LICENSE) [![Node.js: 22.11+](https://img.shields.io/badge/Node.js-22.11%2B-339933)](https://github.com/veerps57/memento/blob/main/.nvmrc)

> A local-first, LLM-agnostic memory layer for AI assistants — **[runmemento.com](https://runmemento.com)**

Every AI session starts the same way: re-explaining your preferences, your project's conventions, the decisions you made last week, the dead-ends to avoid. Each tool solves this in its own siloed way (`CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`, ChatGPT Memory) — but you, the human, are the one constant. Your memory shouldn't fragment across vendors.

Memento is one place where that memory lives. It runs an [MCP](https://modelcontextprotocol.io) server over a local SQLite file, so any MCP-capable AI assistant — Claude Desktop, Claude Code, Cursor, GitHub Copilot, Cline, OpenCode, Aider, a research bot, a custom agent — can read and write durable, structured memory about you, your work, and your decisions. Local-first, no outbound network calls by default, no vendor lock-in.

## Install

```bash
npx @psraghuveer/memento init
```

`init` creates the SQLite database under the XDG default (`$XDG_DATA_HOME/memento/memento.db`, typically `~/.local/share/memento/memento.db` on POSIX), runs migrations, and prints copy-paste MCP snippets for every supported client. Idempotent — re-run any time to reprint the snippets.

For a persistent `memento` on your `$PATH` instead of `npx`:

```bash
npm install -g @psraghuveer/memento
```

Requires Node.js >= 22.11.

## Quickstart

Three steps from zero to a working memory layer:

### 1. Initialize Memento

```bash
npx @psraghuveer/memento init
```

### 2. Connect your AI client

`init` prints, for each client, either a one-line subcommand (e.g. `claude mcp add memento …` for Claude Code) or a JSON snippet to merge into the client's MCP config (Claude Desktop, Cursor, Cline, VS Code Agent mode, OpenCode). Pick the one for your client, paste it, then **restart the client** so it loads the new MCP server.

Per-client walkthrough: [docs/guides/mcp-client-setup.md](https://github.com/veerps57/memento/blob/main/docs/guides/mcp-client-setup.md).

### 3. Teach your assistant when to use Memento

If your client loads Anthropic-format skills, copy the bundled skill into `~/.claude/skills/`:

```bash
cp -R "$(npx -y @psraghuveer/memento skill-path)" ~/.claude/skills/
```

If your client doesn't load skills, paste the [persona snippet](https://github.com/veerps57/memento/blob/main/docs/guides/teach-your-assistant.md) into your client's persona file. Without a skill or persona, the assistant has the MCP tools but no instinct to use them.

## What Memento gives you

- **Local-first** — single SQLite file under your home directory, no cloud, no telemetry, no outbound network calls by default.
- **LLM-agnostic** — no model dependencies, no proprietary APIs. Works with whatever LLM your AI client talks to.
- **MCP-native** — standard MCP server over stdio, so any MCP-capable client plugs in without code changes.
- **Typed memory model** — `fact`, `preference`, `decision`, `todo`, `snippet`. The assistant can reason about what's still true rather than just retrieve text blobs.
- **Append-only audit log** — every write produces an event. Answer "why is this here?" any time.
- **Privacy-conscious** — built-in regex scrubber strips secrets before persistence; patterns are user-configurable.
- **Conflict detection** — a post-write hook flags contradictory memories so they get triaged, not silently coexisting.
- **Vector retrieval** — optional, runs on a local embeddings model (no cloud calls).
- **Portable** — JSONL `export` / `import` for backup, migration, or carrying memory between machines.

## Documentation

- **[runmemento.com](https://runmemento.com)** — overview, comparisons, FAQ
- [README on GitHub](https://github.com/veerps57/memento#readme) — full quickstart, install, MCP client setup
- [ARCHITECTURE.md](https://github.com/veerps57/memento/blob/main/ARCHITECTURE.md) — internal design, data model, retrieval pipeline
- [CLI reference](https://github.com/veerps57/memento/blob/main/docs/reference/cli.md) — every command and flag
- [MCP tools reference](https://github.com/veerps57/memento/blob/main/docs/reference/mcp-tools.md) — every tool exposed to clients
- [Architecture Decision Records](https://github.com/veerps57/memento/tree/main/docs/adr) — decision history with rationale

## About this package

The package is `@psraghuveer/memento`; the binary it installs is `memento`. The CLI is a structural mirror of [`@psraghuveer/memento-server`](https://www.npmjs.com/package/@psraghuveer/memento-server) — both are adapters over the [`@psraghuveer/memento-core`](https://www.npmjs.com/package/@psraghuveer/memento-core) command registry; see [ADR-0003](https://github.com/veerps57/memento/blob/main/docs/adr/0003-single-command-registry.md). Lifecycle commands (`init`, `serve`, `doctor`, `context`, `store migrate`, `export`, `import`) sit alongside a generic projection of the registry surface (`memento <namespace> <verb>`); the full surface is documented in the [CLI reference](https://github.com/veerps57/memento/blob/main/docs/reference/cli.md).

Apache-2.0 licensed. Contributions welcome — see [CONTRIBUTING.md](https://github.com/veerps57/memento/blob/main/CONTRIBUTING.md).
