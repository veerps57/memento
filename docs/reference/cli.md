# CLI Reference

> **This file is auto-generated from `@psraghuveer/memento-core/commands` via `pnpm docs:generate`. Do not edit by hand.**

Every command in the registry whose `surfaces` set includes `cli` is reachable through the `memento` binary.

The dotted command name maps to the subcommand path: `memory.write` is invoked as `memento memory write`.

Argument and flag definitions live in source; this reference lists invocations, descriptions, and side-effect class.

## Invocation

```text
memento [<global-flags>] <command> [<args>]
```

Global flags must appear **before** the subcommand. Registry commands read structured input via `--input <json>`, `--input @file`, `--input -` (stdin), or no flag at all (defaults to `{}`).

## Global flags

| Flag | Description |
| --- | --- |
| `--db <path>` | Database path. Env: `MEMENTO_DB`. Default: `$XDG_DATA_HOME/memento/memento.db` (POSIX: `~/.local/share/memento/memento.db`; Windows: `%LOCALAPPDATA%\memento\memento.db`). |
| `--format json\|text\|auto` | Output format. Env: `MEMENTO_FORMAT`. Default: `auto` (json on a pipe, text on a tty). |
| `--debug` | Print stack traces for unhandled errors. |
| `--version, -V` | Print the memento version and exit. |
| `--help, -h` | Print help and exit. |

## Lifecycle commands

Lifecycle commands sit outside the registry. They manage the CLI process itself (database initialization, MCP transport, runtime introspection) and do not have input/output schemas.

### `memento backup`

Create a point-in-time copy of the database (uses SQLite VACUUM INTO)

### `memento completions`

Emit a shell completion script (bash, zsh, or fish)

### `memento context`

Print runtime context (db, version, registered commands, config snapshot)

**Example.** Print a JSON snapshot of the running CLI:

```bash
memento --db /tmp/example.db --format json context
```

The response is a `Result` envelope. On success, `value` carries the version, the resolved DB path, every registered command (with its surface set and side-effect class), and a snapshot of every config key. Truncated for readability:

```json
{
  "ok": true,
  "value": {
    "version": "0.1.0",
    "dbPath": "/tmp/example.db",
    "registry": {
      "commands": [
        {
          "name": "memory.write",
          "sideEffect": "write",
          "surfaces": ["mcp", "cli"],
          "description": "Create a new memory in the given scope."
        }
      ]
    },
    "config": {
      "retrieval.vector.enabled": false,
      "embedder.local.model": "bge-small-en-v1.5",
      "embedder.local.dimension": 384
    }
  }
}
```

The full snapshot lists every command in the registry and every key in the config schema. `--format text` pretty-prints the same JSON; `--format auto` (the default) chooses based on whether stdout is a TTY.

### `memento doctor`

Run diagnostic checks (Node version, database access, optional dependencies)

**Example.** Verify a fresh install:

```bash
memento --db /tmp/example.db --format json doctor
```

The response is a `Result` envelope. On success, `value.checks` reports one entry per check (Node version, DB path, database open, embedder peer dep) with a stable `name`, a boolean `ok`, and a human-readable `message`. On failure, the same array ships in `error.details` so a bug report can include the full diagnostic without rerunning. DB-class failures map to `STORAGE_ERROR` (exit 5); other failures map to `CONFIG_ERROR` (exit 4).

### `memento explain`

Print the catalogued meaning of an error code (e.g. STORAGE_ERROR)

### `memento export`

Export the configured database to a portable `memento-export/v1` JSONL artefact (ADR-0013)

### `memento import`

Import a `memento-export/v1` JSONL artefact into the configured database (ADR-0013)

### `memento init`

Initialise the database and print MCP client setup snippets

### `memento ping`

Spawn `memento serve`, list tools over MCP stdio, exit

### `memento serve`

Run the MCP server over stdio (blocks until the peer disconnects)

### `memento status`

Print a one-screen summary of the install (counts, last event, db size)

### `memento store migrate`

Run pending database migrations against the configured store

### `memento uninstall`

Print teardown instructions (config paths and database location)

## Registry commands

Total: 30 commands.

### `memento compact run`

Run a single compaction pass. Archives active/forgotten memories whose effective confidence has fallen below the decay threshold and have not been confirmed within the archive window. Idempotent.

- **Side-effect:** `admin` — Operational / introspection.

### `memento config get`

Resolved value for one config key, with source / actor / timestamp.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento config history`

All `ConfigEvent`s for one key, oldest-first. Optional `limit`.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento config list`

Enumerate all registered config keys with their resolved values and provenance. Optional dotted prefix filter.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento config set`

Set a config key at runtime. Persists a `ConfigEvent` to the audit log and updates the in-memory store. Rejects keys marked `mutable: false` with IMMUTABLE.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento config unset`

Clear the runtime override for a config key. The key reverts to whichever lower layer (defaults / startup overrides) had it last. Persists a `ConfigEvent` with `newValue: null`.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento conflict events`

All events for one conflict, oldest first.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento conflict list`

List conflicts. Filters AND together; ordering is opened_at desc, id desc.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento conflict read`

Fetch a single conflict by id, or null if absent.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento conflict resolve`

Resolve an open conflict. Writes a `resolved` event with the chosen resolution.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento conflict scan`

Run conflict detection. In `memory` mode, evaluates per-kind policies for one hydrated memory. In `since` mode, replays detection over every active memory created at or after the given timestamp — used to recover from missed post-write hooks.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento memory archive`

Move a memory to long-term storage. Idempotent on already-archived rows. Requires confirm: true.

Example:

```json
{"id":"01HYXZ...","confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; the CLI requires `--confirm` to execute.

### `memento memory archive_many`

Bulk-archive memories matching a filter. Idempotent on already-archived rows. Requires confirm: true. Defaults to dryRun=true (preview only); set dryRun=false to apply.

Example (dry run):

```json
{"filter":{"kind":"snippet","pinned":false},"confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; the CLI requires `--confirm` to execute.

### `memento memory confirm`

Re-affirm an active memory (bumps lastConfirmedAt, resetting confidence decay).

Example:

```json
{"id":"01HYXZ..."}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento memory confirm_many`

Bulk-confirm multiple active memories in one call (resets confidence decay for each).

Example:

```json
{"ids":["01HYXZ...","01HYXY..."]}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento memory events`

Read the audit log: events for one memory (ascending) when id is given, otherwise recent events across all memories (descending).

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento memory forget`

Soft-remove an active memory; reversible via memory.restore.

Example:

```json
{"id":"01HYXZ...","reason":"No longer relevant","confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; the CLI requires `--confirm` to execute.

### `memento memory forget_many`

Bulk-soft-remove active memories matching a filter. Requires confirm: true. Defaults to dryRun=true (preview only); set dryRun=false to apply.

Example (dry run):

```json
{"filter":{"kind":"todo"},"reason":"Completed sprint","confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; the CLI requires `--confirm` to execute.

### `memento memory list`

List memories matching the given filter, newest first.

Examples:

- All active: `{}`
- Only facts: `{"kind":"fact"}`
- Pinned in a repo: `{"pinned":true,"scope":{"type":"repo","remote":"github.com/acme/app"}}`

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento memory read`

Fetch a single memory by id, or null if absent.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento memory restore`

Move a forgotten or archived memory back to active.

Example:

```json
{"id":"01HYXZ..."}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento memory search`

Search memories by free text using FTS5 + the configured linear ranker.

Examples:

- Simple: `{"text":"database migration"}`
- With filters: `{"text":"auth","kinds":["decision","fact"],"limit":5}`

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento memory set_embedding`

Attach or replace the embedding for an active memory; appends a reembedded event.

- **Side-effect:** `admin` — Operational / introspection.

### `memento memory supersede`

Replace an existing memory with a new one in a single transaction. Use this instead of update when the content changes.

Example:

```json
{"oldId":"01HYXZ...","next":{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["corrected"],"pinned":false,"content":"Updated fact content.","summary":null,"storedConfidence":0.9}}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento memory update`

Update taxonomy fields (tags / kind / pinned) of an active memory. Does NOT change content — use memory.supersede for that.

Example:

```json
{"id":"01HYXZ...","patch":{"tags":["updated-tag"],"pinned":true}}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento memory write`

Create a new memory in the given scope.

Workflow: search first to avoid duplicates. If a similar memory exists, use memory.supersede to update it instead. Use memory.update for non-content changes (tags, pinned).

Minimal example (pinned, storedConfidence, summary, owner all have defaults):

```json
{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["project:memento"],"content":"Memento uses SQLite for storage."}
```

Full example:

```json
{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["project:memento"],"pinned":false,"content":"Memento uses SQLite for storage.","summary":"Storage engine choice","storedConfidence":0.95}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento memory write_many`

Atomically create multiple memories in a single transaction. Per-item clientToken idempotency is honoured; on any failure the whole batch rolls back.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

### `memento system info`

Server health and capability snapshot. Returns version, schema version, db path, vector retrieval status, configured embedder model + dimension, and per-status memory counts. Read-only; safe to call freely.

Tip: call system.list_scopes to discover valid scopes for memory.write.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento system list_scopes`

List every scope that has at least one active memory, with per-scope count and most-recent write timestamp. Sorted by count desc. Read-only; safe to call freely.

Call this before writing to discover valid scopes. If the response is empty, use {"type":"global"} as a safe default scope for memory.write. The returned scope objects can be passed directly to memory.write or memory.search.

- **Side-effect:** `read` — Pure read; safe to call freely.

### `memento system list_tags`

List all tags in use across memories, with per-tag counts sorted by frequency descending. Defaults to active memories only. Read-only; safe to call freely.

Use this to discover valid tags before calling memory.list or memory.search with a tags filter.

- **Side-effect:** `read` — Pure read; safe to call freely.
