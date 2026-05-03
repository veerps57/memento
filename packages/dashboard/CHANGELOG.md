# @psraghuveer/memento-dashboard

## 0.1.3

### Patch Changes

- d70b151: Lean responses + clear signals so AI assistants — and human operators — can use Memento intuitively.

  Themed pass driven by a persona-3 production test (an AI assistant calling Memento over MCP). Every response was audited for "did the assistant know what just happened, what to expect next, and what to do?" — the gaps below were the failures.

  **Embedding vectors stripped from single-memory responses** (`@psraghuveer/memento-core`)

  - `memory.write`, `memory.update`, `memory.confirm`, `memory.forget`, `memory.archive`, `memory.restore`, `memory.supersede`, `memory.set_embedding` no longer echo the 768-float embedding vector back. Previously a single `memory.read` could push ~12KB of pure noise into the assistant's context window for free.
  - `memory.read` now accepts an opt-in `includeEmbedding: true` for the rare debugging case (the only single-memory command where echoing the vector has a real use case).
  - `memory.list` and `memory.search` already stripped by default; behavior unchanged.

  **New `embeddingStatus` field on every memory output** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

  The previous `embedding: null` was ambiguous — an assistant couldn't tell "vector retrieval is off," "embedder hasn't caught up yet," and "stripped from this response" apart. Three states, one response, no infrastructure work for the assistant. Surfaced on every memory output:

  - `'present'` — the vector exists (whether echoed back or stripped)
  - `'pending'` — `retrieval.vector.enabled` is true but the embedder hasn't run yet (common right after a write)
  - `'disabled'` — vector retrieval is off

  Additive (optional field on `MemoryBaseSchema`); existing storage layers and consumers stay unchanged.

  **`get_memory_context` returns a `hint` when results are empty** (`@psraghuveer/memento-core`)

  A fresh assistant calling `get_memory_context` on an empty store would otherwise see `{ results: [], resolvedKinds: [...] }` and have no nudge to start writing. The new `hint` field distinguishes "store is genuinely empty — capture preferences as they come up" from "no matches in the requested scope — try a different filter." Set only when `results.length === 0`; absent otherwise.

  **`extract_memory` response now carries `mode` and `hint`** (`@psraghuveer/memento-core`)

  In the default async mode (per `extraction.processing` config), `memory.extract` returned `{ written: [], skipped: [], superseded: [], batchId, status: 'accepted' }` — empty arrays gave assistants no way to tell users what happened. The response now also includes:

  - `mode: 'sync' | 'async'` — `'sync'` means the arrays are authoritative; `'async'` means processing in background, expect ~1–5 sec, do not retry
  - `hint` (async only) — explicit next-step guidance: "Processing N candidate(s) in background. Results land as memories within ~1–5 seconds; verify with list_memories or search_memory if needed."

  Both fields are additive; sync responses gain `mode: 'sync'`, async responses gain `mode: 'async'` + `hint`.

  **`update_memory` redirect short-circuits redundant errors** (`@psraghuveer/memento-core`)

  Previously, `update_memory({ patch: { content: '...' } })` returned both the helpful `cannot update content — use memory.supersede` redirect (good) AND a redundant `patch must change at least one field` (noise — `content` was the field, the redirect already explained why it was rejected). The `superRefine` now short-circuits the second check when forbidden-key issues already fired, so the response stays a single actionable line.

  **New `user.preferredName` config + `system.info` surface** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

  The bundled assistant skill teaches AIs to attribute writes ("Raghu prefers pnpm" rather than "User prefers pnpm"), but there was no canonical way to discover the user's preferred handle. New `user.preferredName` config key (string, nullable, default `null`); the value is surfaced in `system.info.user.preferredName` so the assistant learns it once at session start. When `null`, the skill instructs the assistant to write "The user" instead. Set with `memento config set user.preferredName "<name>"`.

  **Dashboard personalization + brand-title alignment** (`@psraghuveer/memento-dashboard`)

  - The dashboard wordmark in the top bar now reads `<name>@memento_` when `user.preferredName` is set — a shell-prompt cue that matches the dashboard's terminal aesthetic (`~/overview`, `~/memory/$id` route style). Falls back to `memento_` when null. Reuses the existing blinking-cursor caret; no new visual concept.
  - Browser tab title aligned to `Memento — Dashboard` (was `memento — dashboard`) for visual parity with the landing page (which now reads `Memento — A local-first, LLM-agnostic memory layer for AI assistants` everywhere — `<title>`, OG title, Twitter title).

  **Skill + tool description alignment** (`skills/memento/SKILL.md`, tool descriptions for `write_memory`, `update_memory`, `read_memory`, `extract_memory`, `info_system`, `write_many_memories`)

  The conflict-detection policies for `preference` and `decision` parse the first line of `content` as `key: value` — but the skill's worked example used freeform prose, so AIs following the skill silently bypassed conflict detection. Skill and the `write_memory` tool description now teach a two-line pattern: `topic: value` on line 1 (the structural anchor for the detector) followed by free prose for retrieval. Without that line, two contradictory preferences ("I use bun" vs "I use npm") will silently coexist instead of being surfaced for triage.

  The skill also now contains a **Quick decision tree** appendix covering the four most-touched judgement calls in any session — which write tool (`write_memory` vs `extract_memory` vs N-sequential-writes vs `write_many_memories`), which kind (with the rule-of-thumb "does the user expect to defend the choice if asked 'why'?" → `decision`; otherwise `preference`), which scope (user-facts → `global`, project-facts → `repo`), and when to deviate from the `storedConfidence` / `pinned` / `sensitive` defaults.

  `write_many_memories` tool description rewritten to make clear it is a programmatic / operator surface — for batched explicit user statements, AI assistants should prefer N sequential `write_memory` calls (no all-or-nothing rollback) or `extract_memory` (server dedups + scrubs). `clientToken` description marked as a programmatic-idempotency surface (scripts, migrations, retry-safe pipelines) that AI assistants typically omit. `update_memory` field list corrected from `(tags / kind / pinned)` to `(tags / kind / pinned / sensitive)` everywhere it appeared. `forget` vs `archive` distinction tightened to a single rule: **forget retracts (was wrong); archive retires (was right, no longer current)**.

  The skill additionally documents:

  - The async-extract response contract (`mode` + `hint` — empty arrays are not failure)
  - The `info_system.user.preferredName` flow for user attribution

  `docs/architecture/conflict-detection.md` adds a paragraph noting that the per-policy first-line shape is the contract the skill teaches — so future contributors don't try to "fix" the silent-conflict case by widening the detector and end up with false positives instead. `docs/architecture/data-model.md` documents the new `embeddingStatus` field as a wire-only projection. `docs/architecture/decay-and-supersession.md` and `docs/guides/teach-your-assistant.md` updated to match the corrected `update_memory` field list and to teach the same `key: value` shape + `info_system.user.preferredName` attribution pattern as the skill (so non-skill clients — Cursor, Cline, OpenCode — get the same guidance via the persona snippet).

  **Skill install discoverability** (no package bumps; `skills/README.md`, `CONTRIBUTING.md`, `AGENTS.md`)

  The contributor `memento-dev` skill was essentially undiscoverable — no mention in `CONTRIBUTING.md` or `AGENTS.md`, and `skills/README.md`'s install section was written entirely for the end-user `memento` skill. Now:

  - `skills/README.md`: install section split into "End users: the `memento` skill" (existing path via `memento init`) and "Contributors: the `memento-dev` skill" (one-line `cp -R` install + a "verifying the dev skill auto-triggers" walkthrough)
  - `CONTRIBUTING.md`: new "Install the contributor skill (Claude Code only)" subsection in Local setup
  - `AGENTS.md`: dev-skill install promoted to the top of the "For AI agents specifically" section, framing it as the load-on-intent companion to AGENTS.md itself

  The `memento-dev` skill also picked up two new pitfalls — workspace postinstall coordination (`scripts/ensure-better-sqlite3.mjs` ↔ `packages/cli/scripts/postinstall.mjs`) and the `topic: value` first-line requirement for new `preference` / `decision` features — and corrected the `memory.update` field list to include `sensitive`.

- Updated dependencies [d70b151]
  - @psraghuveer/memento-core@0.5.2
  - @psraghuveer/memento-schema@0.4.1

## 0.1.2

### Patch Changes

- fe72460: Persona-driven UX, install, and brand polish across the CLI, core, dashboard, and embedder.

  **CLI** (`@psraghuveer/memento`)

  - **Node 22.11+ baseline.** Node 20 exited LTS on 2026-04-30; the runtime check in `init` and `doctor` now correctly enforces this. Previously a user on Node 20 would pass the version check but crash later when `better-sqlite3` tried to load against the wrong ABI. CI matrix now tests Node 22 and 24.
  - **`doctor` no longer reports false positives** for `native-binding` and `embedder` checks when run from a bundled CLI inside a workspace (e.g. `node packages/cli/dist/cli.js doctor` against the local build). The probes fall back to a filesystem walk when `require` resolution fails for resolution reasons (not actual binding/load failures), so the doctor's verdict reflects reality instead of a require-graph quirk.
  - **Global flags accepted in any position.** `memento --format text init` and `memento init --format text` now both parse — previously the second form errored "unknown argument '--format' for 'init'". Same for `--db`, `--debug`. `--` separator semantics preserved (POSIX behavior pre-subcommand, pass-through after).
  - **`doctor` text renderer.** A flat ✓/✗ checklist with hint lines on failure and a one-line summary, instead of pretty-printed JSON. JSON path unchanged for pipes / `--format json`.
  - **`init` next-steps footer.** After printing the MCP snippets, `init` now points at `memento status` (one-screen summary) and `memento dashboard` (browser UI). Closes the journey loop instead of dropping the user mid-air.
  - **Help regrouped by purpose** — Setup / Verify & inspect / Operate / Help & teardown — instead of an alphabetical-ish wall.
  - **Banner color now matches the brand accent** (truecolor amber `rgb(232 184 108)`) instead of cyan. Aligns with the dashboard's `--accent` token and the new landing page.
  - **Dashboard launcher always prints the readiness URL** on stderr. Previously gated on `isStderrTTY`, which silently hid the URL from anyone running `memento dashboard --no-open` or with stderr redirected. The browser auto-open is best-effort; the printed URL is now the deterministic surface.
  - **Workspace install self-heal.** A new root `postinstall` (`scripts/ensure-better-sqlite3.mjs`) plus a workspace-detector in the CLI's end-user `postinstall` together prevent the "Could not locate the bindings file" trap that bit every fresh contributor. Source tracked in [`packages/cli/scripts/postinstall.mjs`](https://github.com/veerps57/memento/tree/main/packages/cli/scripts/postinstall.mjs).

  **Core** (`@psraghuveer/memento-core`)

  - **`memory.update` patch validation now hands out actionable redirects** instead of `Unrecognized key(s) in object`. Trying to `update({ patch: { content: ... } })` returns "cannot update `content` via memory.update — use memory.supersede"; same for `scope` (→ supersede) and `storedConfidence` (→ confirm or supersede). Delivers on the promise in AGENTS.md rule 13. Visible to AI assistants over MCP and to humans via `memento memory update`.

  **Embedder** (`@psraghuveer/memento-embedder-local`)

  - **Silenced the noisy `dtype not specified for "model"` warning** that transformers.js emitted on the first `embed()` call by pinning `dtype: 'fp32'` (the bge-\* family's training precision and the lib's own default). Behavior is identical; output is just quieter.

  **Dashboard** (`@psraghuveer/memento-dashboard`)

  - **Command palette feels smoother.** Debounce bumped 120ms → 250ms (the search-as-you-type sweet spot) and TanStack Query's `placeholderData: keepPreviousData` keeps prior results visible during refetch — no more "no matches" flash between keystrokes.
  - **Browser tab title** is now `memento — dashboard` (so users with both the marketing landing and the dashboard open can tell tabs apart) and the dashboard inherits the marketing landing's amber-`m` favicon for visual continuity.

- Updated dependencies [fe72460]
  - @psraghuveer/memento-core@0.5.1

## 0.1.1

### Patch Changes

- abc4216: Republish `@psraghuveer/memento-dashboard` to fix unresolved `workspace:^` specifiers in the published `package.json`.

  The initial `0.1.0` tarball was pushed manually, bypassing the changesets/CI publish path that rewrites pnpm's `workspace:` protocol to concrete semver ranges. As a result, `npm install -g @psraghuveer/memento` fails during dependency resolution because npm cannot resolve `workspace:^` for `@psraghuveer/memento-core` and `@psraghuveer/memento-schema`.

  This release is a no-op republish through the standard `changeset publish` flow, which produces a tarball with the workspace specifiers correctly rewritten to `^0.5.0` and `^0.4.0`.

## 0.1.0

### Minor Changes

- 0186ea0: Add `@psraghuveer/memento-dashboard` and the `memento dashboard` lifecycle command, and fix `memento init` failing when the user deleted only the main `memento.db` and left the SQLite WAL/SHM sidecars behind.

  ## The dashboard

  The new sibling package ships a local-first web UI for browsing, auditing, and curating your Memento store. Every named route lands as a real, functional view rather than a placeholder:

  - **`~/overview`** (D2) — landing page with active count, last write, vector retrieval status, open conflicts; kind breakdown; scope distribution.
  - **`~/memory`** (D3 + D6 + D11) — browse with filter chips (status, kind, pinned), search box wired to `memory.search` (FTS + vector when enabled), sort by `lastConfirmedAt`, decay-aware effective-confidence meter on every row, click-through to detail.
  - **`~/memory/$id`** (D5 + D11 + D12) — full content with sensitive-reveal toggle, supersession chain (up / down links), audit timeline (`memory.events` for that id with type-pill colour coding and per-event payload summary), provenance (created, last confirmed, stored vs. effective confidence), pin / confirm / forget actions.
  - **`~/conflicts`** (D14 + D15 + D16) — pending conflicts triaged as side-by-side memory cards with the four `conflict.resolve` actions (accept-new, accept-existing, supersede, ignore), evidence detail toggle, "re-scan last 24h" button.
  - **`~/audit`** (D7 + D8) — global activity feed via the id-less mode of `memory.events`, with type filters and deep links to each memory.
  - **`~/config`** (D20 + D22) — every registered config key grouped by dotted prefix, with current value, source layer (default / startup / runtime), mutability flag, type-key history per row (`config.history`), and a "copy as `memento config set` command" snippet for friction-free editing via the CLI.
  - **`~/system`** (D19 + D24) — doctor-style probes (database, vector retrieval, embedder, schema version, last write, version) plus a status-count tile row.

  Plus two cross-cutting pieces:

  - **Cmd-K command palette** — global ⌘K / Ctrl-K overlay with three modes: live `memory.search` as you type (debounced), `>` prefix for page navigation, `:` prefix for direct memory open by ULID. Read-only; destructive verbs stay on the detail page where the full context lives.
  - **Inline config editor** on `~/config` — typed editors per row (boolean → checkbox, number → number input, string → text input, otherwise → JSON textarea), inferred from the current value's runtime type. Save calls `config.set`; a "reset to default" button (visible when the source is `runtime`) calls `config.unset`. Engine-side `INVALID_INPUT` and `IMMUTABLE` errors render inline. Known immutable keys are read-only client-side as a UX shortcut, with the server's `IMMUTABLE` response as the canonical fallback.

  Architecturally, the dashboard is a third adapter on the existing command registry — every read and mutation goes through `executeCommand(...)` over the same surface MCP and CLI use. **No new MCP commands, no new registered CLI commands, no new config keys, no schema migrations.** Every view is a thin projection of one or more existing registry commands. See [ADR-0018](docs/adr/0018-dashboard-package.md) for the full rationale.

  Mobile-responsive from day one — every view stacks cleanly at narrow widths and the chrome collapses into a header-toggled drawer.

  The CLI gains one new lifecycle command, `memento dashboard`, that opens a `MementoApp`, mounts the Hono server bound to `127.0.0.1` on a random port, opens the user's browser, and blocks until SIGINT. The dashboard package is loaded via dynamic import so non-dashboard invocations (`memento serve`, `memento doctor`, etc.) do not pay the load cost. The lifecycle command accepts `--port`, `--host 127.0.0.1|localhost`, and `--no-open`; it is print-free on stdout during operation so machine-readable consumers can capture the post-shutdown snapshot via `--format json`.

  `KNOWN_LIMITATIONS.md` and `AGENTS.md` were updated to reflect the reversal of the prior "Web UI out of scope" stance. A TUI remains out of scope; the dashboard covers the same need.

  Stack:

  - Server: Hono on Node, in-process with the engine, with a generic `/api/commands/:name` surface that wraps every registered command.
  - UI: React + Tailwind + TanStack Query / Router, built by Vite into a static SPA. Theme is "warm dark default with one amber accent and one cyan-teal accent," monospace-leaning typography (Inter + JetBrains Mono via `@fontsource/*` for offline-first fonts).
  - Security: same-origin guard on mutating requests; the server binds to `127.0.0.1` only.

  ## Fix: `memento init` cleans orphan WAL/SHM sidecars

  Memento opens its database in WAL mode (`PRAGMA journal_mode = WAL`), which produces three files alongside the main `.db`: `memento.db-wal`, `memento.db-shm`, and (rarely) `memento.db-journal`. SQLite owns the sidecars and recovers from them on next open. If the user removed only `memento.db` (`rm memento.db`), the sidecars survived; the next open created an empty `.db`, set WAL mode, and SQLite tripped on a WAL whose contents did not match the new file. The recovery surfaced as a generic, misleading `STORAGE_ERROR: failed to open database … disk I/O error`.

  `memento init` now detects the half-deleted-store state — main `.db` absent, sidecars present — and removes the orphan sidecars before opening the database. The cleanup is observable in the snapshot as a new `stale-wal-sidecars` `InitCheck` so the operator sees what happened on their behalf rather than a silent surprise.

  The cleanup is sound only when the main `.db` is absent; when the file exists the sidecars belong to SQLite and the check is a no-op (regression test pins this so a future change cannot accidentally over-reach).

  Workaround for prior versions: `rm ~/.local/share/memento/memento.db-wal ~/.local/share/memento/memento.db-shm`, then re-run `memento init`.
