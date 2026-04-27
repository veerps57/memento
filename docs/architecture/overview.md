# Architecture: Overview

This document describes the runtime topology, the major modules, and the data flow for a typical operation. It is the recommended entry point after reading the top-level [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Runtime topology

Memento runs entirely on the user's machine. There is no daemon, no background sync, and no telemetry. A single process — the MCP server — is launched on demand by the AI client and lives only for the duration of the session.

```text
┌─────────────────────────────────────────────────────────────────┐
│  AI Client (Cursor / Claude Code / Cline / Aider / VS Code …)   │
└──────────────────────────────┬──────────────────────────────────┘
                               │  MCP over stdio (JSON-RPC)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    @psraghuveer/memento-server (MCP adapter)                │
│   • Registers tools from the command registry                   │
│   • Validates input via Zod                                     │
│   • Translates command results to MCP tool responses            │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                       @psraghuveer/memento-core                             │
│   ┌──────────────┐  ┌────────────┐  ┌────────────────────────┐  │
│   │  Command     │  │  Scope     │  │  Scrubber              │  │
│   │  Registry    │  │  Resolver  │  │  (secret/PII redact)   │  │
│   └──────┬───────┘  └─────┬──────┘  └────────────────────────┘  │
│          │                │                                     │
│          ▼                ▼                                     │
│   ┌──────────────────────────────┐  ┌─────────────────────┐     │
│   │  Repositories (Kysely)       │  │  Retrieval          │     │
│   │  • memories                  │  │  • FTS5             │     │
│   │  • memory_events (audit)     │  │  • optional vector  │     │
│   │  • config_events             │  │  • ranker           │     │
│   └──────┬───────────────────────┘  └──────────┬──────────┘     │
│          │                                     │                │
│          ▼                                     ▼                │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Conflict-detection hook (post-write, async)            │   │
│   └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  SQLite (better-sqlite3) + FTS5  [+ sqlite-vec, optional]       │
│  One file per running CLI/server. Default: XDG data dir,         │
│  e.g. ~/.local/share/memento/memento.db.                        │
│  Override with --db <path> or MEMENTO_DB. Scope is a row-level  │
│  property inside the database, not a database-selection rule.   │
└─────────────────────────────────────────────────────────────────┘
```

The CLI is a parallel adapter on `core`, not a wrapper around the server. `memento search "topic"` and the equivalent MCP `memory.search` call execute the exact same registry handler.

## The five anchor modules

### 1. Command registry

Every operation Memento exposes — over MCP, the CLI, and any future surface — is defined once in the command registry as a typed handler with a Zod input schema, a Zod output schema, and metadata (name, description, side-effect class). The MCP and CLI adapters are thin projections of the registry. A contract test asserts that for every command, both adapters expose it. There is no way to add a command to one surface and not the other without breaking the build.

This is the structural enforcement of guiding principle 2 (Modular) and 3 (Extensible). Adding a new surface — say, a future HTTP transport — means writing a new adapter, not duplicating logic.

### 2. Scope resolver

Every memory belongs to a scope (`global`, `workspace:<path>`, `repo:<git-remote>`, `session:<id>`, `branch:<name>`). The resolver computes the active scope set for a given operation by composing small, individually testable resolvers (`GitRemoteResolver`, `WorkspacePathResolver`, `SessionResolver`). The composite is a thin policy layer; the underlying resolvers are pure functions of (cwd, git state, environment).

Read-time scope resolution layers scopes from most-specific to least-specific. Write-time scope is explicit on the call.

Detail: [`scope-semantics.md`](scope-semantics.md).

### 3. Repositories

All persistence goes through Kysely repositories with hand-written SQL queries. There is no ORM. Repositories are the only layer that touches SQL outside of migration files.

The two load-bearing tables are `memories` (current state, with denormalized `lastConfirmedAt` and `effectiveConfidence` cached at write-time) and `memory_events` (append-only audit log; the source of truth for history). The `memento doctor` command verifies the cache against the audit log; the cache is otherwise maintained by the writer paths.

Detail: [`data-model.md`](data-model.md).

### 4. Retrieval

`memory.search` runs FTS5 over the content column with a configurable ranker. If `retrieval.vector.enabled=true` and `@psraghuveer/memento-embedder-local` is installed, results are augmented with a vector search and re-ranked by a configurable function of `(ftsScore, vectorScore, effectiveConfidence, recencyBoost)`. The default ranker is one of several config-selectable strategies; users can pin a strategy and tune its weights without touching code.

Detail: [`retrieval.md`](retrieval.md).

### 5. Scrubber

Every write passes through the scrubber before persistence. The scrubber matches against a configurable set of redaction rules (`scrubber.rules`) — secrets, tokens, emails, identifiers — and replaces matches with stable placeholders. Rules are pluggable; the default rule set is conservative and biased toward false positives. Disabling the scrubber is possible (`scrubber.enabled=false`) but is logged at WARN.

Detail: [`scrubber.md`](scrubber.md).

## Data flow: a single `memory.write`

1. Client calls MCP tool `memory.write` with content and intended kind/tags.
2. MCP adapter validates input with the command's Zod schema. Invalid input fails fast with a structured error.
3. The handler calls the scope resolver to bind a scope unless the caller specified one explicitly.
4. The scrubber rewrites the content. If anything was scrubbed, that fact is recorded in the audit event metadata.
5. The repository writes to `memories` and `memory_events` in a single transaction. Immutable fields (`id`, `createdAt`, `schemaVersion`, `scope`) are set; `effectiveConfidence` is computed.
6. The conflict-detection hook is enqueued asynchronously. It does not block the response.
7. The handler returns the new memory's id and a summary; the adapter projects this to the MCP tool response.

A `memory.search` follows the same path, minus the writes. A `memory.supersede` is two writes in one transaction (the superseded memory's status flips, the new memory is written, both audit events are emitted).

## Where to go next

- For the data model in detail: [`data-model.md`](data-model.md).
- For how scopes layer at read time: [`scope-semantics.md`](scope-semantics.md).
- For how retrieval ranks results: [`retrieval.md`](retrieval.md).
- For why memories decay rather than expire: [`decay-and-supersession.md`](decay-and-supersession.md).
- For how conflicts are surfaced without blocking writes: [`conflict-detection.md`](conflict-detection.md).
- For the config surface and validation: [`config.md`](config.md).
- For the scrubber's rule format and defaults: [`scrubber.md`](scrubber.md).
