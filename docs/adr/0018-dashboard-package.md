# ADR-0018: Memento Dashboard as a sibling package

- **Status:** Accepted
- **Date:** 2026-05-02
- **Deciders:** Raghu + Claude
- **Tags:** dashboard, distribution, ui, scope

## Context

Two prior documents pin "Web UI / TUI for browsing memory" as deliberately out of scope:

- `KNOWN_LIMITATIONS.md` table row: *"Treated as a separate product."*
- `AGENTS.md` "Out of scope" list: *"Web UI / TUI."*

The original posture was correct for the v1 surface: keep the core sharp, leave UIs to a sibling, do not let UI concerns infect the registry / scope / decay / conflict modules. That posture is still correct for the **core**.

Two forces have changed the math for the **product**:

1. **Adoption depends on transparency and trust.** The persona audit (P1.5: "see and audit what was remembered" and P1.6: "correct or remove memory at will") is satisfied by the CLI in principle, but in practice users who don't live in terminals never reach those flows. A read-mostly, curate-occasionally GUI is the missing affordance.

2. **The core surface is stable enough.** Memento ships 32 registered commands, 9 lifecycle commands, 9 stable error codes, and a frozen-additive config registry. A dashboard built strictly on that surface costs the core nothing.

The constraint that makes this tractable: **the dashboard introduces no new MCP commands, no new registered CLI commands, no new config keys, no schema migrations.** It is a pure projection of the existing surface, plus four small client-side bridges (tag-filtering on lists, compact preview, sensitive list, global config history) where the registry is deliberately narrow.

## Decision

We add a new workspace package, `@psraghuveer/memento-dashboard`, under `packages/dashboard/`. It provides a localhost web UI that reads from and (selectively) writes to the user's Memento store. The package depends on `@psraghuveer/memento-core` and `@psraghuveer/memento-schema`; it adds no dependencies to those packages.

The dashboard is launched via **one new lifecycle command on the existing CLI**: `memento dashboard`. The lifecycle command opens a `MementoApp` against the configured database, mounts an HTTP server (Hono) on `127.0.0.1:<random-port>`, opens the user's browser to that port, and blocks until SIGINT. The HTTP server serves a Vite-built static SPA and an internal `/api/*` surface that wraps `executeCommand(...)` over the registry.

The internal HTTP API is **not** a public surface in the AGENTS.md sense — it is a private contract between the dashboard's own server and its own UI. Downstream tools must not depend on it; the registry remains the only documented programmatic surface. A future `memento dashboard --no-open` or shared-port mode is additive.

The two prior posture documents are updated:

- `KNOWN_LIMITATIONS.md`: the "Web UI / TUI" row is replaced with a reference to this ADR and the dashboard package.
- `AGENTS.md` "Out of scope" list: the "Web UI / TUI" entry is removed for the same reason.

## Consequences

### Positive

- P1.5 and P1.6 close on a real UI, not just on documentation.
- The constraint "no new registered surface" keeps the core contract stable: every dashboard read maps to an existing registry command, every dashboard mutation goes through `executeCommand`. Nothing the agent population sees changes.
- The package boundary keeps UI dependencies (Vite, React, Tailwind, Hono, TanStack family) entirely out of `core`, `schema`, `server`, `embedder-local`, and the published CLI's runtime surface. The CLI delegates to the dashboard package for `memento dashboard`; the CLI's own dependency graph is unchanged.
- Mobile-responsive from day one; transparency is a property of having access at all, including from a phone.

### Negative

- One new lifecycle command on the CLI (the launch entry point). The existing parity tests are unaffected because lifecycle commands sit outside the registry.
- A new top-level dependency family (UI build chain). This is AGENTS.md's "adds a top-level dependency" trigger and is why this ADR exists — but the dependencies are isolated to the dashboard package's own lockfile entries; consumers of the CLI install them only when running `memento dashboard`.
- Reverses the prior "Web UI out of scope" stance. We owe the reader of the older docs a clear pointer; the updates to `KNOWN_LIMITATIONS.md` and `AGENTS.md` provide it.

### Risks

- **Scope creep.** The dashboard's job is transparency and curation, not "every feature you can imagine on top of Memento." The user-stories listed earlier in this ADR pin the v1 surface; anything beyond it goes through the same ADR / proposal cycle as the rest of the project.
- **UI as a backdoor for surface changes.** The temptation to add "just one server-side endpoint that doesn't fit a registered command" will exist. The mitigation: the dashboard's `/api/*` routes are reviewed by the same lens as registry commands, and any new functionality goes through the registry first (then surfaces in the dashboard as a thin client of the new command).
- **Drift between dashboard and CLI behaviour.** Both wrap the same registry, but the dashboard introduces new code paths (HTTP serialization, browser-side cache invalidation) that could mask bugs the CLI does not see. Mitigation: the dashboard's server tests reuse the in-memory `MementoApp` pattern from `packages/cli/test/`, exercising every route through the same code path as a registry call.

## Alternatives considered

### Alternative A: Keep the prior stance, ship nothing

Attractive: zero churn on existing posture documents, no new top-level dependency family. Rejected: the persona audit gap is real and growing, and the CLI alone has not been enough to close it. "Treat as a separate product" was a correct posture for v1; we are now ready for the second product surface.

### Alternative B: Fold the dashboard into the existing CLI package

Attractive: one fewer workspace package; one publish artefact. Rejected: the CLI's job is to stay small. Adding Vite, React, Tailwind, and the TanStack family to the published `memento` package's tree would inflate every install, including the overwhelming majority that never run `memento dashboard`. The sibling-package shape lets the dashboard's dependencies stay opt-in by way of the user installing the dashboard package explicitly (or via `npx @psraghuveer/memento-dashboard`).

### Alternative C: Publish the dashboard as a fully separate repo, not a workspace package

Attractive: the cleanest possible isolation. Rejected: the build, lint, type-check, and changeset machinery that this workspace already runs are exactly what the dashboard needs; duplicating them in a sibling repo is pointless cost. The workspace boundary is sufficient isolation in practice.

### Alternative D: Ship a static HTML+JS bundle that talks to a separate `memento serve` over a localhost MCP transport

Attractive: "the dashboard is just another MCP client" — purest possible architecture. Rejected: MCP transport is stdio-only today (per AGENTS.md) and adding a localhost WebSocket / SSE bridge is a larger ADR than this one. With the dashboard's own HTTP server in-process holding the `MementoApp`, the dashboard speaks to the engine the same way the CLI does — through `executeCommand(...)` against the registry — without any new transport.

### Alternative E: Skip the dashboard, invest in CLI ergonomics

Attractive: serve the same persona-audit gap by making the CLI good enough at "show me, audit, curate." Rejected: the gap is partly UI but partly **discoverability**. A user who does not know `memento conflict list` exists will never run it. A dashboard with a "Conflicts" tab they can see is the discoverability fix the CLI cannot replicate without becoming a TUI (a separate product the AGENTS.md "out of scope" list deliberately excludes).

## Validation against the four principles

1. **First principles.** The dashboard exists because the persona-audit gap is real and the CLI alone has not closed it. The package boundary exists because the core's simplicity is load-bearing and a UI's dependencies are not compatible with that. Putting the dashboard in a sibling package gives the user the surface they need without imposing it on the agents and operators who don't.
2. **Modular.** The dashboard depends on `@psraghuveer/memento-core` through its public exports only. `executeCommand`, the registry types, and the lifecycle helpers are the entire contact surface. Replacing the dashboard with a different UI (a TUI, a desktop app, a Slack bot) means writing a different package against the same surface.
3. **Extensible.** Every dashboard view is a thin projection of one or more existing commands; new views are added by composing existing commands, not by changing the registry. Future widgets that genuinely need a new command go through the standard ADR / design-proposal cycle — the dashboard doesn't get a fast path.
4. **Config-driven.** No new `ConfigKey` is added by this ADR. The dashboard surfaces existing config keys through `config.list` / `config.get` / `config.set` and respects their `mutable` flag the way the CLI does. The dashboard's own preferences (theme, density, panel layout) are browser-local (`localStorage`), not part of Memento's config registry — they are presentation, not behavior.

## References

- ADR-0003: Single command registry, MCP and CLI as adapters. The dashboard is a third adapter on the same registry.
- ADR-0010: MCP tool naming. The dashboard's API uses the registry name verbatim internally; user-facing labels are human-readable.
- `KNOWN_LIMITATIONS.md` — entry "Web UI / TUI" replaced by a pointer to this ADR.
- `AGENTS.md` — "Out of scope" list, "Web UI / TUI" line removed.
- `docs/user-stories.md` — P1.5, P1.6 (the personas this ADR serves).
