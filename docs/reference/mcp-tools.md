# MCP Tools

> **This file is auto-generated from `@psraghuveer/memento-core/commands` via `pnpm docs:generate`. Do not edit by hand.**

Every command in the registry whose `surfaces` set includes `mcp` is exposed as an MCP tool.

Tool names are `verb_noun` snake_case (per ADR-0010): `read_memory`, `search_memory`, `set_config`. The dotted registry name (`memory.read`) is the CLI subcommand path; the MCP name is derived from it.

Input and output schemas are defined in source as Zod schemas and validated by the adapter on every call;

this reference lists names, descriptions, side-effect class, and the MCP annotation hints each command declares.

Total: 37 tools.

## `run_compact`

Registry name: `compact.run` — CLI: `memento compact run`

Run a compaction pass to archive cold memories whose effective confidence has fallen below the decay threshold and have not been confirmed within the archive window. Idempotent.

Defaults to `mode: "drain"` — loops until a pass archives nothing or `compact.run.maxBatches` is reached. Pass `mode: "batch"` to perform exactly one pass (the legacy single-batch behaviour).

- **Side-effect:** `admin` — Operational / introspection; not part of the data plane.

## `get_config`

Registry name: `config.get` — CLI: `memento config get`

Resolved value for one config key, with source / actor / timestamp.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `list_config_history`

Registry name: `config.history` — CLI: `memento config history`

All `ConfigEvent`s for one key, oldest-first. Optional `limit`.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `list_config`

Registry name: `config.list` — CLI: `memento config list`

Enumerate all registered config keys with their resolved values and provenance. Optional dotted prefix filter.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `set_config`

Registry name: `config.set` — CLI: `memento config set`

Set a config key at runtime. Persists a `ConfigEvent` to the audit log and updates the in-memory store. Rejects keys marked `mutable: false` with IMMUTABLE.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `unset_config`

Registry name: `config.unset` — CLI: `memento config unset`

Clear the runtime override for a config key. The key reverts to whichever lower layer (defaults / startup overrides) had it last. Persists a `ConfigEvent` with `newValue: null`.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `list_conflict_events`

Registry name: `conflict.events` — CLI: `memento conflict events`

All events for one conflict, oldest first.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `list_conflicts`

Registry name: `conflict.list` — CLI: `memento conflict list`

List conflicts. Filters AND together; ordering is opened_at desc, id desc.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `read_conflict`

Registry name: `conflict.read` — CLI: `memento conflict read`

Fetch a single conflict by id, or null if absent.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `resolve_conflict`

Registry name: `conflict.resolve` — CLI: `memento conflict resolve`

Resolve an open conflict. Writes a `resolved` event with the chosen resolution.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `scan_conflicts`

Registry name: `conflict.scan` — CLI: `memento conflict scan`

Run conflict detection. In `memory` mode, evaluates per-kind policies for one hydrated memory. In `since` mode, replays detection over every active memory created at or after the given timestamp — used to recover from missed post-write hooks.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `archive_memory`

Registry name: `memory.archive` — CLI: `memento memory archive`

Move a memory to long-term storage. Idempotent on already-archived rows. Requires confirm: true.

Example:

```json
{"id":"01HYXZ...","confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; clients should confirm before invoking.
- **MCP hints:** idempotentHint=`true`

## `archive_many_memories`

Registry name: `memory.archive_many` — CLI: `memento memory archive_many`

Bulk-archive memories matching a filter. Idempotent on already-archived rows. Requires confirm: true. Defaults to dryRun=true (preview only); set dryRun=false to apply.

Example (dry run):

```json
{"filter":{"kind":"snippet","pinned":false},"confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; clients should confirm before invoking.
- **MCP hints:** idempotentHint=`true`

## `confirm_memory`

Registry name: `memory.confirm` — CLI: `memento memory confirm`

Re-affirm an active memory (bumps lastConfirmedAt, resetting confidence decay).

Example:

```json
{"id":"01HYXZ..."}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `confirm_many_memories`

Registry name: `memory.confirm_many` — CLI: `memento memory confirm_many`

Bulk-confirm multiple active memories in one call (resets confidence decay for each).

Example:

```json
{"ids":["01HYXZ...","01HYXY..."]}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `get_memory_context`

Registry name: `memory.context` — CLI: `memento memory context`

Load the most relevant memories for the current session without a search query. Uses ranked retrieval based on confidence, recency, scope, pinned status, and confirmation frequency.

Call at the start of a task to load context. No arguments required — returns the top memories from config-driven defaults.

Every result's memory carries an `embeddingStatus` field (`"present"` | `"pending"` | `"disabled"`) so callers can tell whether a row contributed via vector similarity at all.

Examples:

- Default: `{}`
- Scoped: `{"scopes":[{"type":"repo","remote":"github.com/org/app"},{"type":"global"}]}`
- Filtered: `{"kinds":["preference","decision"],"limit":10}`

- **Side-effect:** `read` — Pure read; safe to call freely.

## `list_memory_events`

Registry name: `memory.events` — CLI: `memento memory events`

Read the audit log: events for one memory (ascending) when id is given, otherwise recent events across all memories (descending).

Optional `types`, `since`, `until`, and `limit` narrow the result set; `since`/`until` filter on the event `at` timestamp (half-open: `at >= since AND at < until`). There is no scope / kind / tag filter — events are not denormalised by those dimensions.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `extract_memory`

Registry name: `memory.extract` — CLI: `memento memory extract`

Batch-extract candidate memories from a conversation. The server handles dedup, scrubbing, and writing. The assistant's job is reduced to dumping "what seemed worth remembering."

**Candidate shape note** — this command's `kind` field is a flat string (`"kind": "fact"`), and `rationale` / `language` are top-level fields. This differs from `memory.write`, where `kind` is a discriminated-union object and those fields nest inside it. Copying the write_memory shape will fail validation with `INVALID_INPUT`.

**Topic-line gotcha** — for `preference` and `decision` candidates, the `content` MUST start with a `topic: value` line followed by a blank line and prose. The conflict detector parses that first line; without it, contradictory preferences silently coexist. The handler returns `INVALID_INPUT` for offending candidates — the whole batch is rejected, not just the bad items.

Dedup runs at two scopes: (1) **in-batch** — byte-identical candidates within the same call collapse to a single memory (kind-aware fingerprint); (2) **cross-batch** — embeddings are compared against existing active memories via the configured similarity thresholds (≥`extraction.dedup.identicalThreshold` skips, between that and `extraction.dedup.threshold` supersedes, below writes new). When in doubt, include the candidate.

**Storage defaults** — extracted memories are written at `storedConfidence: 0.8` (lower than `memory.write`'s 1.0) so they decay faster and get pruned if never confirmed. This biases toward precision: tentative captures don't crowd out user-stated facts.

The response carries a `mode` field. When `mode: "sync"`, the `written`, `skipped`, and `superseded` arrays are authoritative and you can report them directly. When `mode: "async"` (the default per `extraction.processing` config), those arrays are intentionally empty — the server returned a receipt and is processing in background. The accompanying `hint` field explains what to expect; do not retry. Writes land as memories within ~1–5 seconds and can be confirmed with `list_memories` or `search_memory` if needed.

Example (note the flat kind, the topic-line on the preference, and top-level rationale on the decision):

```json
{"candidates":[
  {"kind":"preference","content":"editor-theme: dark\n\nUser prefers dark mode in all editors."},
  {"kind":"fact","content":"The production database is PostgreSQL 15."},
  {"kind":"decision","content":"storage-engine: SQLite\n\nChosen for the local-first story; FTS5 built in.","rationale":"Single-file, no daemon, prebuilt for every platform."},
  {"kind":"snippet","content":"memento read <id>","language":"shell"}
]}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `forget_memory`

Registry name: `memory.forget` — CLI: `memento memory forget`

Soft-remove an active memory; reversible via memory.restore.

Example:

```json
{"id":"01HYXZ...","reason":"No longer relevant","confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; clients should confirm before invoking.

## `forget_many_memories`

Registry name: `memory.forget_many` — CLI: `memento memory forget_many`

Bulk-soft-remove active memories matching a filter. Requires confirm: true. Defaults to dryRun=true (preview only); set dryRun=false to apply.

Example (dry run):

```json
{"filter":{"kind":"todo"},"reason":"Completed sprint","confirm":true}
```

- **Side-effect:** `destructive` — Bulk or irreversible; clients should confirm before invoking.

## `list_memories`

Registry name: `memory.list` — CLI: `memento memory list`

List memories matching the given filter, newest first.

Examples:

- All active: `{}`
- Only facts: `{"kind":"fact"}`
- Pinned in a repo: `{"pinned":true,"scope":{"type":"repo","remote":"github.com/acme/app"}}`

- **Side-effect:** `read` — Pure read; safe to call freely.

## `read_memory`

Registry name: `memory.read` — CLI: `memento memory read`

Fetch a single memory by id, or null if absent. By default the embedding vector is stripped (callers almost never need 768 floats); pass `includeEmbedding: true` for the raw vector.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `restore_memory`

Registry name: `memory.restore` — CLI: `memento memory restore`

Move a forgotten or archived memory back to active. Treated as an implicit confirm: `lastConfirmedAt` is bumped to now so the restored memory is not immediately re-eligible for compaction.

Example:

```json
{"id":"01HYXZ..."}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `search_memory`

Registry name: `memory.search` — CLI: `memento memory search`

Search memories by free text using FTS5 + the configured linear ranker.

Query text is treated as a term bag: FTS5 syntax (AND / OR / NOT / NEAR / phrase / prefix) is NOT parsed — sigils are stripped and tokens are ranked via BM25 + vector similarity.

Every result's memory carries an `embeddingStatus` field (`"present"` | `"pending"` | `"disabled"`) so a vector score of 0 can be distinguished between "the row has no embedding yet" (`pending`) and "the content was not similar" (`present`).

Examples:

- Simple: `{"text":"database migration"}`
- With filters: `{"text":"auth","kinds":["decision","fact"],"limit":5}`

- **Side-effect:** `read` — Pure read; safe to call freely.

## `set_memory_embedding`

Registry name: `memory.set_embedding` — CLI: `memento memory set_embedding`

Attach or replace the embedding for an active memory; appends a reembedded event.

- **Side-effect:** `admin` — Operational / introspection; not part of the data plane.
- **MCP hints:** idempotentHint=`true`

## `supersede_memory`

Registry name: `memory.supersede` — CLI: `memento memory supersede`

Replace an existing memory with a new one in a single transaction. Use this instead of update when the content changes.

History is preserved: the old memory transitions to `superseded` and its `supersededBy` field links to the new memory. The transaction emits a `superseded` audit event on the old id and a matching `created` event on the new id, so `memory.events` shows the chain from either side.

Example:

```json
{"oldId":"01HYXZ...","next":{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["corrected"],"pinned":false,"content":"Updated fact content.","summary":null,"storedConfidence":0.9}}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `update_memory`

Registry name: `memory.update` — CLI: `memento memory update`

Update non-content fields (tags / kind / pinned / sensitive) of an active memory. Does NOT change content — use memory.supersede for that.

`kind` patches: same-type edits (e.g. updating a snippet's `language` in place, updating a decision's `rationale`) succeed. Cross-type kind changes (snippet → fact, decision → preference, etc.) are rejected with INVALID_INPUT — route them through memory.supersede so kind-specific metadata stays in the audit chain.

Example:

```json
{"id":"01HYXZ...","patch":{"tags":["updated-tag"],"pinned":true}}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `write_memory`

Registry name: `memory.write` — CLI: `memento memory write`

Create a new memory in the given scope.

Workflow: search first to avoid duplicates. If a similar memory exists, use memory.supersede to update it instead. Use memory.update for non-content changes (tags, kind, pinned, sensitive).

For `preference` and `decision` kinds, start the content with a single `topic: value` line followed by free prose. Conflict detection parses that first line — without it two contradictory preferences silently coexist. Example: `node-package-manager: pnpm\n\nRaghu prefers pnpm over npm for Node projects.`

Minimal example (pinned, storedConfidence, summary, owner all have defaults):

```json
{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["project:memento"],"content":"Memento uses SQLite for storage."}
```

Full example:

```json
{"scope":{"type":"global"},"kind":{"type":"fact"},"tags":["project:memento"],"pinned":false,"content":"Memento uses SQLite for storage.","summary":"Storage engine choice","storedConfidence":0.95}
```

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `write_many_memories`

Registry name: `memory.write_many` — CLI: `memento memory write_many`

Atomically create multiple memories in a single transaction. Per-item clientToken idempotency is honoured; on any failure the whole batch rolls back.

Programmatic / operator surface — AI assistants typically do NOT reach for this. For multiple explicit user statements ("remember A, B, and C"), prefer N sequential `write_memory` calls so one bad item does not roll the others back. For end-of-session sweeps over things the user mentioned in passing, use `extract_memory` (server dedups + scrubs + lowers confidence). Use `write_many_memories` only when you genuinely need all-or-nothing transactional semantics — e.g. importing a curated batch from a doc.

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `export_pack`

Registry name: `pack.export` — CLI: `memento pack export`

Build a memento pack manifest (YAML) from memories matching a filter. Read-only. The CLI lifecycle wraps this with `memento pack create` for file IO; assistants and the dashboard call it directly.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `install_pack`

Registry name: `pack.install` — CLI: `memento pack install`

Install a memento pack — a curated YAML bundle of memories — from the bundled registry, a local file, or an HTTPS URL. Stamps `pack:<id>:<version>` provenance on every memory; idempotent on unchanged content; refuses with PACK_VERSION_REUSED on content drift without a version bump (ADR-0020).

- **Side-effect:** `write` — Mutates state and emits an audit-log event.

## `list_packs`

Registry name: `pack.list` — CLI: `memento pack list`

List installed packs — every active memory's `pack:<id>:<version>` tag is grouped, returning the pack id, version, scope, and memory count.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `preview_pack`

Registry name: `pack.preview` — CLI: `memento pack preview`

Preview what `pack.install` would write. Resolves the manifest, classifies the install state (fresh / idempotent / drift), and returns the items without persisting. Read-only.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `uninstall_pack`

Registry name: `pack.uninstall` — CLI: `memento pack uninstall`

Forget every active memory installed by a pack — single version (default) or `allVersions: true`. Composes with the bulk-destructive contract from ADR-0014: dry-run defaults true, `confirm: true` is required, the `safety.bulkDestructiveLimit` cap applies on apply.

- **Side-effect:** `destructive` — Bulk or irreversible; clients should confirm before invoking.

## `info_system`

Registry name: `system.info` — CLI: `memento system info`

Server health and capability snapshot. Returns version, schema version, db path, vector retrieval status, configured embedder model + dimension, per-status memory counts, open-conflict count, runtime info (Node version, modules ABI, native-binding state), scrubber state (write-path redaction master switch), and `user.preferredName` (the name an assistant should use when authoring memory content; falls back to "The user" when null). Read-only; safe to call freely — call once at session start to learn the user's name and the store's capabilities.

Tip: call system.list_scopes to discover valid scopes for memory.write.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `list_scopes_system`

Registry name: `system.list_scopes` — CLI: `memento system list_scopes`

List every scope that has at least one active memory, with per-scope count and most-recent write timestamp. Sorted by count desc. Read-only; safe to call freely.

Call this before writing to discover valid scopes. If the response is empty, use {"type":"global"} as a safe default scope for memory.write. The returned scope objects can be passed directly to memory.write or memory.search.

- **Side-effect:** `read` — Pure read; safe to call freely.

## `list_tags_system`

Registry name: `system.list_tags` — CLI: `memento system list_tags`

List all tags in use across memories, with per-tag counts sorted by frequency descending. Defaults to active memories only. Read-only; safe to call freely.

Use this to discover valid tags before calling memory.list or memory.search with a tags filter.

- **Side-effect:** `read` — Pure read; safe to call freely.
