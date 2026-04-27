# GitHub Copilot Instructions

This file is read automatically by GitHub Copilot in VS Code and other Copilot-enabled environments.

**The canonical instruction set for all AI agents working on Memento lives in [`AGENTS.md`](../AGENTS.md) at the repository root.** This file exists only to point Copilot at it; everything below is a brief summary. Do not duplicate content here — read `AGENTS.md` directly.

## Read this first

1. [`AGENTS.md`](../AGENTS.md) — guiding principles, architectural rules, common pitfalls, verification commands.
2. [`ARCHITECTURE.md`](../ARCHITECTURE.md) — high-level architecture and links into the deeper docs.
3. [`docs/adr/`](../docs/adr/) — every architectural decision and why it was made.

## Path-specific guidance

When you edit files in these areas, the canonical reference is:

- `**/*.test.ts` — [`AGENTS.md`](../AGENTS.md) § "Architectural rules" + § "Verification"; tests must use Vitest, mirror the source layout under `packages/<pkg>/test/`, and keep the 90/90/90/90 coverage gate green.
- `packages/core/src/storage/migrations/**` — [ADR-0001](../docs/adr/0001-sqlite-as-storage-engine.md) and existing migrations under that directory; migrations are forward-only and must include matching tests under `packages/core/test/storage/migrations/`.
- `packages/core/src/commands/**` — [ADR-0003](../docs/adr/0003-single-command-registry.md) and [`packages/core/README.md`](../packages/core/README.md); every command lands in the single registry and is projected to MCP and CLI by adapters.
- `docs/**` — generated reference docs under `docs/reference/` are produced by `pnpm docs:generate` (do not hand-edit); architectural prose under `docs/architecture/` and ADRs under `docs/adr/` follow the templates already in those directories.

## Reusable workflows

These live as concise checklists rather than executable prompt files:

- **Add a command:** define schemas in `@psraghuveer/memento-schema`, register the command in `packages/core/src/commands/`, add tests, run `pnpm docs:generate` to refresh `docs/reference/cli.md` and `docs/reference/mcp-tools.md`. ADR-0003 is the contract.
- **Add a config key:** add a `defineKey` entry to `packages/schema/src/config-keys.ts`, follow the JSDoc-style guidance at the top of that file, then `pnpm docs:generate` to refresh `docs/reference/config-keys.md`.
- **Add a migration:** add the next-numbered migration under `packages/core/src/storage/migrations/` with a matching test under `packages/core/test/storage/migrations/`. Migrations are forward-only.

## The four principles, in one breath

First principles. Modular. Extensible. Config-driven.

If a change cannot be justified against these, it should not land.

## Verification before opening a PR

```bash
pnpm install && pnpm verify
```

`pnpm verify` mirrors the CI gate (lint, typecheck, build, test, test:e2e, docs:lint, docs:check). See `AGENTS.md` for the full pre-PR checklist.
