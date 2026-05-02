# Architecture

This file is the entry point to Memento's architecture. It is intentionally short. The deeper documents live in [`docs/architecture/`](docs/architecture/) and [`docs/adr/`](docs/adr/).

## Reading order

1. **[Overview](docs/architecture/overview.md)** — what Memento is, the runtime topology, and the major modules.
2. **[Data model](docs/architecture/data-model.md)** — `Memory`, `MemoryEvent`, `OwnerRef`, `Scope`, and how they relate.
3. **[Scope semantics](docs/architecture/scope-semantics.md)** — how scopes are resolved, layered, and queried.
4. **[Retrieval](docs/architecture/retrieval.md)** — FTS, optional vector search, ranking, and re-ranking.
5. **[Decay and supersession](docs/architecture/decay-and-supersession.md)** — how memories age and how new memories replace old ones.
6. **[Conflict detection](docs/architecture/conflict-detection.md)** — the post-write hook and conflict surfacing.
7. **[Configuration](docs/architecture/config.md)** — `ConfigKey`, layering, validation, and dynamic update.
8. **[Scrubber](docs/architecture/scrubber.md)** — secret redaction and PII reduction at the boundary.
9. **[ADRs](docs/adr/)** — the why behind every load-bearing decision.

## The shape, in one paragraph

A user runs `npx memento serve` and their AI client launches it as an MCP server. The server exposes a small set of typed commands (`memory.write`, `memory.search`, `memory.supersede`, etc.) over stdio. Commands are defined once in a registry and projected to both MCP and the human-facing CLI by adapters; parity is structural. A third surface — a local-first web dashboard — is launched by `npx memento dashboard` (ADR-0018) and reads/writes through the same registry. State lives in a local SQLite database with FTS5 (and an optional brute-force vector backend). Every state-changing operation writes an audit event. Behavior — decay half-lives, retrieval weights, conflict thresholds, scrubber rules — is shaped by configuration, not code. There are no outbound network calls by default; the only optional remote interaction is downloading the local embedding model on first use.

## The four guiding principles

These shape every decision below. They are repeated here for emphasis. Long-form discussion is in [`AGENTS.md`](AGENTS.md).

1. First principles.
2. Modular.
3. Extensible.
4. Config-driven by the user.

## Module map

```text
packages/
├── schema/           Shared Zod schemas → TS types via z.infer
├── core/             Domain logic: data model, command registry,
│                     repositories, decay, retrieval, conflict
├── server/           MCP adapter; thin projection of the registry
├── cli/              CLI adapter; thin projection of the registry,
│                     plus the npx entry point and lifecycle commands
│                     (`init`, `serve`, `dashboard`, `context`, `doctor`,
│                     `status`, `ping`, `backup`, `export`, `import`,
│                     `store migrate`, `completions`, `explain`, `uninstall`)
├── embedder-local/   transformers.js + bge-base-en-v1.5
│                     Regular dep; lazy-loaded on first embed()
├── dashboard/        Web dashboard adapter (ADR-0018); Hono server
│                     in-process with the engine + Vite-built React SPA.
│                     Lazy-loaded by `memento dashboard`.
└── landing/          Marketing landing page. Static SPA (Vite + React),
                      private (not published to npm). Deployed to GitHub
                      Pages on push to main; mirrors the dashboard's
                      design tokens. Has no runtime relationship with
                      the rest of the workspace.
```

The dependency graph is acyclic and one-way: `cli`, `server`, and `dashboard` depend on `core`; `core` depends on `schema`; `embedder-local` and `dashboard` are loaded by `cli` only at runtime through dynamic imports, so non-dashboard / non-vector invocations never pay their startup cost. `landing` is standalone — it imports nothing from the other packages and exists in the workspace only to inherit the lint / typecheck / format gates.

## Status

See [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) for the current list of out-of-scope features and active limitations.
