# AGENTS.md

> Canonical instructions for AI coding agents working on Memento.

This file is read by tools that follow the [agents.md](https://agents.md) convention — Cursor, Cline, Aider, Claude Code, OpenCode, and others. `CLAUDE.md` is a symlink to this file. `.github/copilot-instructions.md` points back here.

If you are an AI agent: **read this entire file before making any change.** If you are a human working with an AI agent, please ensure the agent has read this file.

## What Memento is

Memento is a local-first, LLM-agnostic memory layer for AI assistants. It runs an MCP server over a local SQLite database. Any MCP-capable client — coding assistants, desktop chat clients, custom agents — can read and write durable, structured memory through it.

A full architectural walkthrough is in [ARCHITECTURE.md](ARCHITECTURE.md). Decision history is in [docs/adr/](docs/adr/).

## The four guiding principles

Every change must be justified against these. They are non-negotiable.

1. **First principles.** Every construct exists because we proved we need it. Not "because that's how things are usually done."
2. **Modular.** Any component must be replaceable without rewriting the rest.
3. **Extensible.** New variants must not require breaking changes.
4. **Config-driven by the user.** Behavior is shaped by configuration, not by code.

## Architectural rules — non-negotiable

These are encoded as tests and CI gates where possible. Do not bypass them.

1. **Single command registry → MCP and CLI as adapters.** Every command exists in the registry once and is projected to both surfaces by adapters. Parity is structural, not aspirational.
2. **No hardcoded behavioral constants.** Anything that affects retrieval, decay, conflict detection, scrubbing, or storage behavior MUST be a `ConfigKey`. Adding a constant in code is a code-review rejection.
3. **Every state-changing operation writes an audit event** (`MemoryEvent` for memory changes, `ConfigEvent` for config changes).
4. **`OwnerRef` is always populated**, even when it is always `{ type: 'local', id: 'self' }`. The model is multi-user-ready from day one.
5. **Immutable fields stay immutable.** `id`, `createdAt`, `schemaVersion`, and `scope` are never mutated after creation. To "move" a memory between scopes, supersede it with a new memory in the new scope.
6. **Status transitions are explicit.** A `forgotten` memory does not silently become `active`. Every transition has its own command (`forget`, `restore`, `archive`, `supersede`).
7. **Exhaustive switches on discriminated unions** use the `assertNever` pattern. A structural test asserts that decay, retrieval, and conflict-detection rules exist for every `MemoryKind`.
8. **Conflict detection runs via a post-write hook**, never inline. The write path does not block on conflict checks beyond a configured timeout.
9. **Decay is computed at query time, not stored.** Effective confidence is `stored × decayFactor(now − lastConfirmedAt, halfLife)`. The `compact` job materializes archives for memories that have decayed below threshold.
10. **`ScopeResolver` is composed of small, mockable resolvers** (`GitRemoteResolver`, `WorkspacePathResolver`, `SessionResolver`). The composite is a thin policy layer.
11. **`MemoryEvent` is the audit source of truth.** `lastConfirmedAt` on `Memory` is a denormalized cache, validated at write-time and by `npx @psraghuveer/memento doctor`.
12. **No configurable invariants.** Integrity rules (immutability, status transitions, supersession atomicity) are hardcoded. Configurable invariants are no invariants.
13. **`memory.update` only mutates non-content fields** (tags, kind, pinned). Content changes route through `supersede` to preserve history. The error message points the caller to the right command.
14. **Embedding model migration is explicit.** `memento embeddings rebuild` is the only way to re-embed memories. Never silent.

## Before you start a change

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and the architecture overview at [docs/architecture/overview.md](docs/architecture/overview.md).
2. Read the ADRs in [docs/adr/](docs/adr/) — at minimum, scan the index. Read in full any ADR touching the area you are changing.
3. Read this entire file.
4. For any non-trivial change, open a [design proposal issue](.github/ISSUE_TEMPLATE/design_proposal.yml) **before** writing code. The design proposal forces ADR-style thinking and lets reviewers catch architectural drift early. Trivial changes (typos, doc fixes, single-file refactors with no behavior change) can go straight to a PR.

## How to do common things

Each of these is a short checklist; the canonical reference is the listed file or ADR.

- **Add a command:** define schemas in `@psraghuveer/memento-schema`, register the command via the appropriate factory in `packages/core/src/commands/` (e.g. `createMemoryCommands`), add tests, then run `pnpm docs:generate` to refresh `docs/reference/cli.md` and `docs/reference/mcp-tools.md`. The contract is [ADR-0003](docs/adr/0003-single-command-registry.md); the registry shape is documented in [`packages/core/README.md`](packages/core/README.md).
- **Add a config key:** add a `defineKey` entry to `packages/schema/src/config-keys.ts` following the comment block at the top of that file, then run `pnpm docs:generate` to refresh `docs/reference/config-keys.md`. Per-key Zod schemas validate every write; immutable keys must be flagged.
- **Add a migration:** add the next-numbered migration under `packages/core/src/storage/migrations/` with a matching test under `packages/core/test/storage/migrations/`. Migrations are forward-only ([ADR-0001](docs/adr/0001-sqlite-as-storage-engine.md)).

When editing files under `packages/core/src/commands/**`, `packages/core/src/storage/migrations/**`, `**/*.test.ts`, or `docs/**`, the architectural rules and the pre-PR verification steps below still apply.

## Verification — run before opening a PR

You **must** run these locally before opening a PR. Do not trust CI as the first signal.

```bash
pnpm install
pnpm verify          # lint -> typecheck -> build -> test -> test:e2e -> docs:lint -> docs:check
```

`pnpm verify` mirrors the CI gate. If it passes locally, CI on the same commit should pass too (modulo OS-specific surprises in the matrix). The individual scripts (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm docs:lint`, `pnpm docs:check`, `pnpm build`) remain available for tighter inner loops while iterating.

Dedicated contract and property test suites are not part of the verify chain; contract-style coverage is folded into the unit suites and property invariants are checked by example tests. `pnpm test` is the full required test gate.

## Common pitfalls — record new ones as you find them

This list grows over time. If you trip over something that should have been on it, add it as part of your PR.

- **Do not import from `@psraghuveer/memento-core` private paths.** Use the public exports from each package's `index.ts`. Private paths are an implementation detail.
- **Do not write SQL directly.** Use Kysely repositories. Raw SQL is reserved for migration files.
- **Do not add a new `MemoryKind`** without updating the decay, retrieval, and conflict-detection policies for it. The structural test will fail.
- **Do not bypass the scrubber, even in tests.** Use `--scrubber.enabled=false` in a fixture if you genuinely need raw input; do not skip the call site.
- **Migrations are append-only.** Never edit a shipped migration file. Add a new one.
- **Do not add hardcoded behavioral constants.** If you find yourself typing a magic number, ask: should this be a `ConfigKey`? The answer is almost always yes.
- **Do not invent APIs that don't exist.** Always verify imports and method signatures against the actual codebase. Hallucinated APIs are the #1 failure mode in AI-authored PRs.
- **Do not bypass `assertNever` exhaustiveness checks.** They exist precisely to catch missed cases when adding new variants.

## Out of scope — do not implement

These are deliberate omissions. Do not add them. The architecture leaves the door open for additive extensions, but they are not part of the product.

- Cloud embedding providers (OpenAI, etc.) — Memento is fully local.
- Plugin / extension system. The `plugin.*` config namespace is reserved.
- Multi-user / team-scoped memory. The data model supports it; commands do not.
- HTTP / SSE transport for MCP. stdio only.
- Encryption at rest.
- Sync across machines.
- Single-binary distribution.
- Web UI / TUI.

If you believe Memento needs one of these, open a [design proposal](.github/ISSUE_TEMPLATE/design_proposal.yml) — do not just implement it.

## When you are unsure

Do not invent. Ask.

- Open a draft PR with the question in the description.
- Use the [design proposal issue template](.github/ISSUE_TEMPLATE/design_proposal.yml) for non-trivial changes.
- Ask in [GitHub Discussions](https://github.com/) for general questions.

The cost of asking is small. The cost of a confidently wrong PR is large.

## For AI agents specifically

If you are an AI coding agent, please:

- **Disclose your involvement** in the PR description (the PR template has a section for this).
- **Verify every line you generate.** Hallucinated imports, fabricated API calls, and invented config keys are the most common failure modes.
- **Run the verification commands locally.** "It looked right" is not verification.
- **Cite specific files and line numbers** when explaining your change. If you cannot, you may not have read enough context.
- **Prefer small, focused PRs.** A 200-line PR that does one thing is far easier to review than a 2000-line PR that does ten things, even if both are correct.
- **Stop and ask** if you find yourself making more than one architectural decision in a single change. That is a sign the change should be a design proposal first.

## License

Contributions are accepted under the project's [Apache-2.0 license](LICENSE). By submitting a contribution, you agree to license it under the same terms.
