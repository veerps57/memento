# @psraghuveer/memento-dashboard

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
