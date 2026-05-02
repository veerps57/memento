# @psraghuveer/memento-dashboard

Local-first web dashboard for [Memento](https://github.com/veerps57/memento). Browse memories, audit history, triage conflicts, tune config — in your browser, against your local SQLite store. Mobile-responsive.

> **Status:** v0 (under active development). See [ADR-0018](../../docs/adr/0018-dashboard-package.md) for the architectural decision and scope. The user-stories driving the v1 surface are tracked in the design proposal that accompanied this package.

## Usage

The dashboard is launched by the main Memento CLI:

```bash
memento dashboard
```

This opens a localhost server (random port, `127.0.0.1` only), launches your default browser, and serves the dashboard against your configured `MEMENTO_DB`. The server stays open until you `Ctrl-C`.

## What the dashboard does (v0)

- **Overview** (`~/overview`) — at-a-glance store status: memory counts by kind and status, scope distribution, recent activity, conflict pressure, vector retrieval state.
- **Memory browse** (`~/memory`) — search box wired to `memory.search` (FTS + vector when enabled), filter chips for status / kind / pinned, decay-aware effective-confidence meter on every row, click-through to detail.
- **Memory detail** (`~/memory/$id`) — full content with sensitive-reveal toggle, supersession chain (up / down navigation), audit timeline (`memory.events` for that id with type-pill colour coding and per-event payload summaries), provenance (created, last confirmed, stored vs. effective confidence), pin / confirm / forget actions.
- **Conflict triage** (`~/conflicts`) — pending conflicts as side-by-side memory cards with the four `conflict.resolve` actions (accept-new, accept-existing, supersede, ignore), evidence detail toggle, "re-scan last 24h" button.
- **Audit feed** (`~/audit`) — global activity feed via the id-less mode of `memory.events`, with type filters and deep links to memory detail.
- **Config browse + inline editor** (`~/config`) — every registered config key grouped by dotted prefix with current value, source layer, and per-key history. Mutable keys edit inline via typed editors (boolean → checkbox, number → number input, string → text input, otherwise → JSON textarea); save calls `config.set` with engine-side per-key Zod validation surfacing inline. Reset (when source is `runtime`) calls `config.unset`.
- **System & health** (`~/system`) — doctor-style probes (database, vector retrieval, embedder, schema version, last write, version) plus a status-count tile row.
- **Cmd-K command palette** — global ⌘K / Ctrl-K overlay with three modes: live `memory.search` as you type, `>` prefix for page navigation, `:` prefix for direct memory open by ULID.

## What the dashboard deliberately does NOT do

See the "What the dashboard deliberately should NOT do" section of the design proposal. Short version: no hard-delete, no conflict auto-resolution, no editing of immutable fields, no raw SQL surface, no auth, no telemetry, no remote-MCP-server config. It's a transparent viewer + careful curator, not an agent.

## Architecture

- **Server:** [Hono](https://hono.dev) on Node, in-process with the Memento engine. Mounts an internal `/api/*` surface that wraps `executeCommand(...)` over the registry from [`@psraghuveer/memento-core`](../core). The HTTP API is a private contract between this server and its own UI; downstream tools must not depend on it.
- **UI:** React + Tailwind + shadcn/ui-style components, [TanStack Query](https://tanstack.com/query) for the data layer, [TanStack Router](https://tanstack.com/router) for in-SPA navigation.
- **Build:** [Vite](https://vitejs.dev) for the SPA bundle (output to `dist-ui/`); [tsup](https://tsup.egoist.dev) for the server bundle (output to `dist/`). Both ship in the npm tarball.

The dashboard speaks to the engine through the **same code path** the CLI and MCP server use — `executeCommand` against the registry. No new backend surface; the dashboard is a third adapter on the existing contract (CLI and MCP being the other two).

## Development

Quick look against your real `MEMENTO_DB`:

```bash
pnpm dev:dashboard       # builds + launches `memento dashboard --port 3004`
```

Per-package commands:

```bash
pnpm -F @psraghuveer/memento-dashboard build       # build server + UI bundles
pnpm -F @psraghuveer/memento-dashboard dev         # vite dev server (proxies /api to localhost:4747)
pnpm -F @psraghuveer/memento-dashboard test        # run tests
```

For UI hot-reload, run `memento dashboard --port 4747 --no-open` in one terminal and `pnpm -F @psraghuveer/memento-dashboard dev` in another, then open `http://localhost:5173`. The Vite proxy forwards `/api/*` to `:4747`. The full walkthrough lives in [`docs/guides/dashboard.md`](../../docs/guides/dashboard.md).

## License

Apache-2.0. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
