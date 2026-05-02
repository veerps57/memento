# The Memento dashboard

`memento dashboard` opens a local-first web UI against your Memento store. It reads (and selectively writes) memory through the same command registry the CLI and MCP server use — no new public surface, no new commands, no schema changes. It exists because the persona-audit gap from ADR-0016 is partly a discoverability problem: a user who doesn't know `memento conflict list` exists will never run it, but the same user can recognise a "Conflicts" tab. The architectural rationale and full scope live in [ADR-0018](../adr/0018-dashboard-package.md).

This guide is the operator-facing companion: how to launch it, what each view shows in v0, the dev workflow for iterating on it, and the failure modes worth knowing.

## Launching

### One-shot (production-style)

```bash
npx @psraghuveer/memento dashboard
```

That opens a localhost HTTP server on a random port (the OS picks; `127.0.0.1` only — never `0.0.0.0`), launches your default browser, and serves the dashboard against the database that `MEMENTO_DB` (or `--db`, or the XDG default) points at. `Ctrl-C` stops it. The post-shutdown snapshot (URL, port, version, whether the browser actually opened) prints to stdout.

Useful flags:

- `--port <n>` — bind to a specific port. Default `0` (OS picks). The two-terminal hot-reload workflow below pins this to `4747` (the port the Vite proxy forwards to); the `pnpm dev:dashboard` convenience script pins it to `3004`.
- `--host 127.0.0.1|localhost` — only these two are accepted in v0. The dashboard is single-user, single-machine; binding to `0.0.0.0` is intentionally not an option.
- `--no-open` — don't auto-open the browser. Use when running headless or when you want to open the URL by hand.

You can always combine with the global `--db`:

```bash
npx @psraghuveer/memento --db ~/.local/share/memento/memento.db dashboard
```

### From a clone

```bash
pnpm build
node packages/cli/dist/cli.js dashboard
```

Same behaviour as the npx invocation.

## What you see (v0)

Every named route ships as a real, functional view. The chrome is shared; each route is a thin projection of one or more registered commands.

**Top bar** — wordmark, command palette trigger (⌘K / Ctrl-K — see below), mobile drawer toggle.

**Sidebar** (`md:` breakpoint and up; otherwise a drawer) — six entries mirroring Memento's command namespaces:

- `~/overview` (D2) — landing page with headline tiles, kind breakdown, scope distribution.
- `~/memory` (D3 + D6 + D11) — browse with filter chips and search box; click a row to drill into detail. Effective-confidence meter on every row, decay-aware.
- `~/memory/$id` (D5 + D11 + D12) — full content with sensitive-reveal toggle, supersession chain, audit timeline, provenance, pin / confirm / forget actions.
- `~/conflicts` (D14 + D15 + D16) — pending conflicts as side-by-side memory cards with the four `conflict.resolve` actions, evidence detail toggle, "re-scan last 24h" button.
- `~/audit` (D7 + D8) — global activity feed (id-less mode of `memory.events`), with type filters and deep links to memory detail.
- `~/config` (D20 + D22) — every registered config key grouped by dotted prefix, with current value, source layer, mutability flag, type-key history, and a "copy as `memento config set` command" snippet.
- `~/system` (D19 + D24) — doctor-style probes (database, vector retrieval, embedder, schema version, last write, version) plus a status-count tile row.

**Cmd-K** opens a command palette from anywhere. Three modes: type to search memories (live `memory.search`); `>` to navigate (e.g. `>conf` matches `~/conflicts` and `~/config`); `:` to open a memory directly by ULID. Arrow keys to highlight, Enter to commit, Esc to close. Read-only by design — destructive verbs (`forget`, `archive`) stay on the memory detail page where the full content, supersession chain, and audit timeline are visible at the moment of the irrevocable choice.

**Status bar** — db path, active memory count, vector retrieval state, version. Always visible; refetches on focus.

**Landing page** — three rows:

1. Headline tiles: active memories, last-write timestamp, vector retrieval status, open conflict count.
2. By-kind breakdown: one tile per `MemoryKind` (fact / preference / decision / todo / snippet) with counts and percentages.
3. By-scope distribution: top scopes with counts and last-write per scope.

If your store is empty you'll see "no scopes yet — your store is empty." Write a few memories first to make the landing page useful:

```bash
memento memory write --input '{"scope":{"type":"global"},"kind":{"type":"preference"},"tags":["tooling"],"content":"Raghu prefers pnpm over npm for Node projects."}'
```

The "by kind" breakdown is approximate above 1000 active memories — it's computed client-side from a `memory.list` snapshot capped at 1000 (the `memory.list.maxLimit` config). You'll see `(of last 1000)` in the section header when that's the case. A future addition to `memory.list` for exact aggregate counts is queued as a separate design proposal; not blocking v0.

## Dev workflow

Two flows depending on what you're iterating on.

### Quick look against your real DB

```bash
pnpm dev:dashboard
```

Builds the four dashboard-relevant packages (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`, `@psraghuveer/memento-server`, `@psraghuveer/memento-dashboard`) plus the CLI, then launches `memento dashboard --port 3004` against your default `MEMENTO_DB`. Same shape as `pnpm dev:server`. The pinned port keeps the URL stable across restarts so a browser tab pointing at `http://localhost:3004` keeps working. `Ctrl-C` stops it.

### UI hot reload (two-terminal)

For iterating on the React UI with Vite HMR:

```bash
# Terminal A — dashboard backend on the fixed port the Vite proxy expects
node packages/cli/dist/cli.js dashboard --port 4747 --no-open

# Terminal B — Vite dev server with HMR
pnpm -F @psraghuveer/memento-dashboard dev
```

Open `http://localhost:5173` in your browser. Vite proxies `/api/*` to `:4747`. UI edits hot-reload instantly; backend edits (anything under `packages/dashboard/src/server/` or `packages/cli/src/lifecycle/dashboard.ts`) require a Terminal A restart.

If you change the proxy port, change both sides — `vite.config.ts`'s `server.proxy['/api'].target` must match what you pass to `--port`. The Vite-flow port (`4747`) and the convenience-script port (`3004`) are intentionally different so both can run side-by-side.

## Architecture (just enough)

The dashboard server is in-process with the engine. The `memento dashboard` lifecycle command opens a single `MementoApp`, dynamic-imports the dashboard package's `createDashboardServer({ registry, ctx })`, and binds the resulting Hono app to a localhost port via `@hono/node-server`. There's no separate process for the engine; the API routes call `executeCommand(...)` against the in-memory registry directly.

Every API route maps to one or more registered commands:

- `POST /api/commands/:name` — execute the named registry command, body is the input, response is the `Result<T>` envelope verbatim.
- `GET /api/commands` — list every registered command (for the command palette).
- `GET /api/health` — server liveness + UI bundle status.

The `/api/*` surface is **not** a public contract. Downstream tools must not depend on it; the registry remains the only documented programmatic surface (per ADR-0003 and ADR-0018). If you need to script against Memento, use the CLI or MCP.

A same-origin guard rejects mutating requests whose `Origin` header doesn't start with `http://127.0.0.1:` or `http://localhost:`. This is the v0 CSRF defence; a per-session token is queued for v1 if real-world telemetry shows we need it.

## Troubleshooting

**"bundle not built" page.** The dashboard server is running but `packages/dashboard/dist-ui/index.html` was not produced by `pnpm build`. Run `pnpm -F @psraghuveer/memento-dashboard build` (or `pnpm build` from the workspace root). The dev workflow's Vite server side-steps this — its bundle is in-memory.

**Port already in use.** If `--port 4747` collides with another process, switch to `--port 0` (OS picks) for the one-shot flow, or pick a different port for the dev flow (and update `vite.config.ts` to match).

**Empty landing tiles, "loading…" forever.** Network panel will show whether `/api/commands/system.info` returned. If it's 403, the same-origin guard rejected it — make sure you're loading from a `localhost:` or `127.0.0.1:` origin and not a tunnel / proxy that strips the `Origin` header. If it's 500 with `STORAGE_ERROR`, it's the same DB-open path `memento serve` would use — `memento doctor` triages.

**Browser doesn't open automatically.** `--no-open` is the explicit opt-out, but the open call is also best-effort and silently fails on hosts without an `xdg-open`-equivalent (some headless servers, some container images). The URL printed on stderr is what you copy and paste.

**`better-sqlite3` ABI mismatch.** Same surface as the rest of Memento. `npm rebuild better-sqlite3 --build-from-source`.

## What the dashboard deliberately does not do

For the canonical list see ADR-0018. The short version:

- No hard delete — forget and archive only, both audit-logged.
- No conflict auto-resolution — every resolution is a user decision.
- No edit of immutable fields (`id`, `createdAt`, `scope`) — content edits route through `supersede`.
- No raw SQL surface — power users have the CLI.
- No login / auth — `127.0.0.1`-bound only. If the threat model requires multi-user, that's a different design.
- No telemetry. Memento is local-first; the dashboard inherits that.

## What's queued

The v0 routes (including the command palette and inline config editor) ship in this PR. The natural next chunks build on them:

1. **D17 — about-to-be-archived view** on `~/system` or `~/config` — surface memories below the decay archive threshold with a one-click `compact.run` preview.
2. **D4 — bulk select / bulk pin / bulk forget** on `~/memory` (the foundation is the row click + checkbox column).
3. **`memory.context` preview widget** — a search-bar-like input showing exactly the ranked rows the agent would see, with the score breakdown visualised. The single highest-leverage "trust delivery" view we have not built.
4. **D9 — conflict scope filter / kind filter on `~/conflicts`** — the data is already there, just needs chips.
5. **Palette: write verbs** — supersede, write-new, archive (each behind a confirm step) so the palette becomes a full keyboard-driven console.

None require new MCP commands or schema changes. Each can ship behind its own changeset.

## License

Apache-2.0. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
