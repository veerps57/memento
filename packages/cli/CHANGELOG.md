# @psraghuveer/memento

## 0.4.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [fe72460]
  - @psraghuveer/memento-core@0.5.1
  - @psraghuveer/memento-embedder-local@0.3.1
  - @psraghuveer/memento-dashboard@0.1.2

## 0.3.3

### Patch Changes

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

- Updated dependencies [0186ea0]
  - @psraghuveer/memento-dashboard@0.1.0

## 0.3.2

### Patch Changes

- a9826e1: Add the Memento skill bundle and surface it from `memento init`.

  The new bundle (`skills/memento/SKILL.md`) teaches Anthropic-skill-capable
  clients — Claude Code, Claude Desktop, Cowork — when to call the Memento
  MCP tools (`write_memory`, `extract_memory`, `get_memory_context`,
  `confirm_memory`, `supersede_memory`, `forget_memory`, …), how to choose
  scope and kind, when to supersede instead of update, and how to handle
  conflicts and sensitive content. Closes the adoption gap from ADR-0016
  without requiring users to hand-paste a persona snippet. Clients that do
  not load Anthropic skills (Cursor, VS Code Agent, OpenCode) continue to
  use the persona-snippet alternative in
  `docs/guides/teach-your-assistant.md`.

  `memento init` now ships an "── Memento skill (optional) ──" section
  gated on the rendered client set: shown when at least one
  skill-capable client is present, suppressed otherwise. The skill
  source is staged into the npm tarball by a build-time
  `copy-skills.mjs` script so `npx`-only users get a real absolute
  path to copy from. `init` is still print-only by design — the
  section lists a `cp -R …` command rather than mutating the user's
  skills directory.

  The `InitSnapshot` contract grows one new field, `skill: SkillInstallInfo`
  — additive — and `ClientSnippet` grows `supportsSkills: boolean`. No
  existing fields change shape.

## 0.3.1

### Patch Changes

- Updated dependencies [d1b6aaf]
  - @psraghuveer/memento-schema@0.4.0
  - @psraghuveer/memento-core@0.5.0
  - @psraghuveer/memento-embedder-local@0.3.0
  - @psraghuveer/memento-server@0.2.1

## 0.3.0

### Minor Changes

- 544e96b: Add memory.context and memory.extract commands (ADR-0016)

  - `memory.extract`: batch extraction with embedding-based dedup (skip/supersede/write) and configurable confidence defaults
  - `memory.context`: query-less ranked retrieval for session-start context injection
  - ~13 new config keys for extraction thresholds, context limits, and ranking weights
  - Remove dead code (`commands/memory/errors.ts`)
  - Harden test coverage across bulk commands, retrieval pipeline, CLI lifecycle, and doc renderers

### Patch Changes

- Updated dependencies [544e96b]
  - @psraghuveer/memento-core@0.4.0
  - @psraghuveer/memento-schema@0.3.0
  - @psraghuveer/memento-server@0.2.0
  - @psraghuveer/memento-embedder-local@0.2.1

## 0.2.1

### Patch Changes

- f099020: Fix embedder resolution failure in global npm installs by removing the `createRequire` gate that silently returned `undefined` when the package was actually present.

## 0.2.0

### Minor Changes

- 1fdbf05: Embeddings default-on: flip `retrieval.vector.enabled` to `true`, add `embedding.autoEmbed` config key for fire-and-forget embedding on write, upgrade default model to `bge-base-en-v1.5` (768d), move `@psraghuveer/memento-embedder-local` to a regular dependency, and make the search pipeline degrade gracefully to FTS-only on transient embed failures.

### Patch Changes

- Updated dependencies [1fdbf05]
  - @psraghuveer/memento-core@0.3.0
  - @psraghuveer/memento-schema@0.2.0
  - @psraghuveer/memento-embedder-local@0.2.0
  - @psraghuveer/memento-server@0.1.3

## 0.1.3

### Patch Changes

- Updated dependencies [b64dd5d]
  - @psraghuveer/memento-core@0.2.0
  - @psraghuveer/memento-embedder-local@0.1.1
  - @psraghuveer/memento-server@0.1.2

## 0.1.2

### Patch Changes

- 3957548: Improve MCP tool usability for AI agents

  - Add `.describe()` annotations to all Zod input schemas with examples and format hints
  - Inject OpenAPI 3.1 discriminator hints into JSON Schema output for discriminated unions
  - Include Zod issue summary in INVALID_INPUT error messages for self-correction
  - Default `owner` to `{"type":"local","id":"self"}`, `summary` to `null`, `pinned` and `storedConfidence` to config-driven values (`write.defaultPinned`, `write.defaultConfidence`)
  - Add usage examples to command descriptions
  - Enhance tool discoverability: scope hints, confirm gate guidance, workflow notes

- Updated dependencies [3957548]
  - @psraghuveer/memento-schema@0.1.1
  - @psraghuveer/memento-core@0.1.1
  - @psraghuveer/memento-server@0.1.1

## 0.1.1

### Patch Changes

- c6e2d95: Fix `memento init` failing on fresh hosts where the platform data directory (e.g. `~/.local/share/memento/` or `%LOCALAPPDATA%\memento\`) did not yet exist. `init` now creates the parent directory recursively before the writability check, so the first run on a brand-new laptop succeeds.
