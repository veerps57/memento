---
name: memento-dev
description: How to contribute changes to the Memento codebase — the local-first MCP memory layer at github.com/veerps57/memento. Trigger this skill whenever the user is working in a checkout of the Memento repo (look for AGENTS.md and packages/{schema,core,server,cli,dashboard,embedder-local,landing} at the repo root) and any of the following holds — the user is editing source under packages/, the user is adding or changing a command / config key / migration / ADR, the user mentions "the Memento repo" or "this repo" while inside a Memento checkout, the user is debugging a failing pnpm verify run, or the user asks "how do I contribute" / "where does X go" / "what are the rules". Do NOT trigger this skill when Memento is merely a dependency of another project (look for a memento entry in package.json dependencies, not at the repo root) — that is an end-user context where the `memento` skill applies. Do NOT trigger for unrelated TypeScript work, even if a Memento checkout happens to be open elsewhere.
---

<!-- doc-links: resolve-from-repo-root -->

# Memento Dev

You are working on the Memento codebase. This skill encodes the rules every change must follow, the verification steps that must pass, and the cadence (ADRs, changesets, docs:generate) that keeps the project coherent across human and AI contributors.

The canonical reference is [`AGENTS.md`](AGENTS.md) at the repo root. This skill is a load-friendly summary. When they conflict, treat AGENTS.md as final and update this skill in the same PR.

## The four guiding principles

Every change is judged against these. They are non-negotiable.

1. **First principles.** Every construct exists because we proved we need it — not "because that is how things are usually done."
2. **Modular.** Any component must be replaceable without rewriting the rest.
3. **Extensible.** New variants must not require breaking changes.
4. **Config-driven by the user.** Behavior is shaped by configuration, not by code.

The PR template asks you to address each one explicitly. Default-empty answers are a smell.

## The 14 architectural rules

Encoded as tests and CI gates where possible. Do not bypass them.

1. **Single command registry → MCP and CLI as adapters.** Every command lives in the registry once and is projected to both surfaces. Parity is structural, not aspirational.
2. **No hardcoded behavioral constants.** Anything affecting retrieval, decay, conflict detection, scrubbing, or storage MUST be a `ConfigKey`. Adding a magic number in code is a code-review rejection.
3. **Every state-changing operation writes an audit event.** `MemoryEvent` for memory changes, `ConfigEvent` for config changes.
4. **`OwnerRef` is always populated** — even when always `{ type: 'local', id: 'self' }`. The model is multi-user-ready from day one.
5. **Immutable fields stay immutable** — `id`, `createdAt`, `schemaVersion`, `scope`. To "move" a memory between scopes, supersede it with a new memory in the new scope.
6. **Status transitions are explicit.** A `forgotten` memory does not silently become `active`. Every transition has its own command (`forget`, `restore`, `archive`, `supersede`).
7. **Exhaustive switches** on discriminated unions use the `assertNever` pattern. A structural test asserts that decay, retrieval, and conflict-detection rules exist for every `MemoryKind`.
8. **Conflict detection runs via a post-write hook**, never inline. The write path does not block on conflict checks beyond `conflict.timeoutMs`.
9. **Decay is computed at query time, not stored.** Effective confidence is `stored × decayFactor(now − lastConfirmedAt, halfLife)`. The `compact` job materializes archives for memories that have decayed below threshold.
10. **`ScopeResolver` composes small, mockable resolvers** (`GitRemoteResolver`, `WorkspacePathResolver`, `SessionResolver`). Adding a new scope dimension means adding a resolver, not mutating the composite.
11. **`MemoryEvent` is the audit source of truth.** `lastConfirmedAt` on `Memory` is a denormalized cache, validated at write-time and by `npx @psraghuveer/memento doctor`.
12. **No configurable invariants.** Integrity rules (immutability, status transitions, supersession atomicity) are hardcoded. Configurable invariants are no invariants.
13. **`memory.update` only mutates non-content fields** (tags, kind, pinned, sensitive). Content changes route through `supersede` to preserve history. The error message points the caller to the right command.
14. **Embedding model migration is explicit.** `memento embedding rebuild` is the only way to re-embed memories. Never silent.

## Common pitfalls

- **Hallucinated APIs are the #1 failure mode in AI-authored PRs.** Verify every import and method signature against the actual codebase before writing code. If you cannot cite a file and line for an API you are calling, you are guessing.
- **Importing from `@psraghuveer/memento-core` private paths.** Use the public exports from each package's `index.ts`. Private paths are an implementation detail.
- **Writing raw SQL.** Use Kysely repositories. Raw SQL is reserved for migration files only.
- **Editing a shipped migration.** Migrations are append-only. Add a new one.
- **Adding a new `MemoryKind`** without updating decay, retrieval, AND conflict policies. The structural test fails.
- **Bypassing the scrubber in tests.** Use `--scrubber.enabled=false` in a fixture if you need raw input; do not skip the call site.
- **Bypassing `assertNever` exhaustiveness checks.** They exist precisely to catch missed cases when adding new variants.
- **Touching one postinstall without the other.** `scripts/ensure-better-sqlite3.mjs` (root) and `packages/cli/scripts/postinstall.mjs` (CLI) cooperate to prevent the "Could not locate the bindings file" trap. The CLI hook early-exits via `isWorkspaceCheckout()` so it doesn't fight the root heal in dev. Edit them together — editing one in isolation re-introduces the trap for every fresh contributor.
- **Adding a `preference` or `decision` feature that authors content as freeform prose.** The conflict detector's `preference` and `decision` policies parse the **first line** of `content` as `topic: value` (or `topic = value`) — that's the structural anchor that makes "I use bun" vs "I use npm" surface as a conflict. Free-prose content silently bypasses detection. New surfaces that auto-write preferences must include the first-line anchor; the assistant skill (`skills/memento/SKILL.md`) teaches the same pattern. See [`docs/architecture/conflict-detection.md`](docs/architecture/conflict-detection.md) for the rationale.
- **Referencing working notes in committed artefacts.** Exploratory drafts, eval reports, dogfood journals, audit prompts, and any `DO NOT COMMIT` file are private working memory. Code, tests, comments, commit messages, and committed docs must not cite, quote, or link them. Rationale lives in the code, the ADR, and the commit message — not in a sidecar. → AGENTS.md §Common pitfalls.

## How to do common tasks

### Add a command

1. Define schemas in `packages/schema/src/`.
2. Register the command via the appropriate factory in `packages/core/src/commands/<namespace>/` (e.g. `createMemoryCommands`, `createConflictCommands`).
3. Add unit tests under `packages/core/test/` — every command needs at least one happy-path and one error test.
4. Run `pnpm docs:generate` to refresh `docs/reference/cli.md` and `docs/reference/mcp-tools.md`.
5. Add a changeset (`pnpm changeset`) if the command is part of the public surface.

The contract is [ADR-0003](docs/adr/0003-single-command-registry.md). Tool naming is [ADR-0010](docs/adr/0010-mcp-tool-naming.md): default rule is `noun.verb` → `verb_noun`; declare `metadata.mcpName` only when overriding the default (e.g. `memory.list` → `list_memories`).

### Add a config key

1. Add a `defineKey` entry to `packages/schema/src/config-keys.ts` following the JSDoc-style guidance at the top of that file.
2. Per-key Zod schema validates every write.
3. Mark `mutable: false` for anything that must not change after server start (storage flags, embedder dimension, etc.).
4. Run `pnpm docs:generate` to refresh `docs/reference/config-keys.md`.

### Add a migration

1. Add the next-numbered migration under `packages/core/src/storage/migrations/` (e.g. `0006_<descriptor>.ts`).
2. Add a matching test under `packages/core/test/storage/migrations/`.
3. Migrations are forward-only ([ADR-0001](docs/adr/0001-sqlite-as-storage-engine.md)). No `down`. Editing a shipped migration is a code-review rejection.

### Add an ADR

1. ADRs are required when you change the public MCP/CLI surface, the data model, scope semantics, a top-level dependency, a load-bearing default, or reverse a previous decision.
2. Use [`docs/adr/template.md`](docs/adr/template.md) as the starting point.
3. Number sequentially (next number is one higher than the highest existing).
4. Set `Status: Accepted` only after the PR merges. Draft PRs use `Status: Proposed`.
5. Cosmetic edits to existing ADRs (typos, broadened framing) are fine in-place. **Decision** changes require a new superseding ADR.

## Verification — run before opening a PR

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs, in order:

1. `lint` (Biome)
2. `typecheck` (`tsc -b`)
3. `build` (per-package tsup)
4. `test` (Vitest, excludes e2e)
5. `test:e2e` (builds CLI, drives it over MCP stdio)
6. `docs:lint` (markdownlint)
7. `docs:reflow:check` (one paragraph per line, no hard wrap)
8. `docs:check` (verifies `docs/reference/` is in sync with the registry)

If `docs:reflow:check` fails, run `pnpm docs:reflow` to apply the fix. If `docs:check` fails, run `pnpm docs:generate` and commit the regenerated `docs/reference/`.

Coverage gate is 90% lines + 90% branches (enforced in `vitest.config.ts`). **Coverage trend:** also run `pnpm test:coverage` and confirm the `All files` row (lines / branches / functions / statements) does not drop vs your starting commit. Per-file drops on a touched file mean missing tests, not a relaxed rule. → AGENTS.md §Verification.

## Markdown convention

One paragraph per line, no hard wrap. Editor soft-wraps. Enforced by `scripts/reflow-md.mjs` in `pnpm verify`. Long lines look ugly in raw form but render correctly and produce reviewable diffs (one diff per paragraph, not one per wrap point).

## Commit messages and changesets

Conventional Commits — the type prefix matters because the changelog is generated from it:

```text
feat(server): add new command
fix(core): preserve confidence on supersede when not provided
docs(architecture): clarify decay function
chore(deps): bump @modelcontextprotocol/sdk to 1.x
```

For PRs that change published behavior, add a changeset:

```bash
pnpm changeset
```

Then **rename the generated file** so it sorts chronologically:

```text
.changeset/<UTC-timestamp>-<slug>.md
```

Get the timestamp with `date -u +"%Y-%m-%dT%H%M"`. Example: `.changeset/2026-05-02T1430-fix-init-creates-db-parent-dir.md`.

Pure docs / test-only / CI / repo-tooling changes do not need a changeset.

## Out of scope — do not implement without an ADR

These are deliberate omissions, documented in [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md). Do not add them as part of an incidental PR:

- Cloud embedding providers
- Plugin / extension system
- Multi-user / team-scoped commands (data model is ready, commands are not)
- HTTP / SSE transport (stdio only)
- Encryption at rest
- Live sync across machines
- Single-binary distribution
- TUI for browsing memory (the web dashboard covers this)

If you believe one of these belongs in the product, open a [design proposal issue](.github/ISSUE_TEMPLATE/design_proposal.yml) — do not just implement it.

## When you are unsure

- For non-trivial changes, open a [design proposal issue](.github/ISSUE_TEMPLATE/design_proposal.yml) before writing code. The template forces ADR-style thinking.
- For small changes where you want a sanity check, open a draft PR with the question in the description.
- Cite specific files and line numbers when explaining your change. If you cannot, you may not have read enough context.
- Prefer small, focused PRs. A 200-line PR that does one thing is far easier to review than a 2000-line PR that does ten things, even if both are correct.

## Opening a PR — mirror the template (for AI agents especially)

The [PR template](.github/PULL_REQUEST_TEMPLATE.md) is not advisory. Every PR body MUST contain every section in it, in order, without renaming: Problem, Change, Justification against the four principles, Alternatives considered, Tests, Local verification, ADR, AI involvement, Linked issues. Mark genuinely-absent items as `N/A` with a one-sentence reason — empty is a smell.

Hand-rolling a PR body that omits required sections is the single most common preventable rework. If you are about to open a PR via `gh pr create --body "..."` or `--body-file`, copy the template content as the starting structure and fill each section in — don't invent your own headers.

The "AI involvement" section in particular is mandatory for AI-authored PRs. AI-authored PRs are welcome; opaque ones are not.

The same gates apply equally to human and AI contributors. "It looked right" is not verification — `pnpm verify` is.

## Interactive collaboration

When the user is reviewing each commit (pair-programming, multi-PR session, interactive agent mode in any tool):

- **Do not auto-commit.** When the work for a commit is complete, run `pnpm verify` and `pnpm test:coverage`, then pause and present a review summary (files changed, tests added, coverage delta, docs touched). Wait for explicit go-ahead before `git commit`.
- **Docs sweep per commit.** Before asking for review, scan `docs/architecture/`, `docs/guides/`, `docs/adr/`, and package READMEs for prose that should reflect the change. Update what drifted; do not punt to a follow-up commit.

Autonomous batch sessions skip these — they only fire when a human is reviewing commit-by-commit. → AGENTS.md §For AI agents specifically.
