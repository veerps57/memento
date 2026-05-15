# AGENTS.md

> Canonical instructions for AI agents working on the Memento codebase.

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
4. **`OwnerRef` is always populated**, even when it is always `{ type: 'local', id: 'self' }`. The model is multi-user-ready from day one. `memento import` enforces this rule by rewriting any non-local-self `OwnerRef` in an imported artefact to the local owner — see [ADR-0019](docs/adr/0019-import-re-stamp-policy.md).
5. **Immutable fields stay immutable.** `id`, `createdAt`, `schemaVersion`, and `scope` are never mutated after creation. To "move" a memory between scopes, supersede it with a new memory in the new scope.
6. **Status transitions are explicit.** A `forgotten` memory does not silently become `active`. Every transition has its own command (`forget`, `restore`, `archive`, `supersede`).
7. **Exhaustive switches on discriminated unions** use the `assertNever` pattern. A structural test asserts that decay, retrieval, and conflict-detection rules exist for every `MemoryKind`.
8. **Conflict detection runs via a post-write hook**, never inline. The write path does not block on conflict checks beyond a configured timeout.
9. **Decay is computed at query time, not stored.** Effective confidence is `stored × decayFactor(now − lastConfirmedAt, halfLife)`. The `compact` job materializes archives for memories that have decayed below threshold.
10. **`ScopeResolver` is composed of small, mockable resolvers** (`GitRemoteResolver`, `WorkspacePathResolver`, `SessionResolver`). The composite is a thin policy layer.
11. **`MemoryEvent` is the audit source of truth.** `lastConfirmedAt` on `Memory` is a denormalized cache, validated at write-time and by `npx @psraghuveer/memento doctor`. `memento import` never trusts caller-supplied audit claims: by default the source artefact's per-memory event chain is collapsed into one synthetic `imported` event whose `actor` and `at` reflect the importer, not the source — see [ADR-0019](docs/adr/0019-import-re-stamp-policy.md).
12. **No configurable invariants.** Integrity rules (immutability, status transitions, supersession atomicity) are hardcoded. Configurable invariants are no invariants.
13. **`memory.update` only mutates non-content fields** (tags, kind, pinned, sensitive). Content changes route through `supersede` to preserve history. Same-type kind edits (e.g. updating a snippet's `language` in place, updating a decision's `rationale`) are allowed; cross-type kind changes (snippet → fact, decision → preference, etc.) are rejected with `INVALID_INPUT` and route through `supersede` so kind-specific metadata stays in the audit chain. The error message points the caller to the right command.
14. **Embedding model migration is explicit.** `memento embedding rebuild` is the only way to re-embed memories. Never silent.

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
- **Stress-test the engine:** run `node scripts/stress-test.mjs` (modes: `quick` / `standard` / `full`) to exercise correctness, write throughput, search/list latency, recall, and `compact` end-to-end against a fresh `/tmp` database. Useful before tagging a release or after large engine changes. The runner emits a markdown report you can diff across runs. See [`docs/guides/stress-test.md`](docs/guides/stress-test.md) for flags, thresholds, and how to read the output.
- **Measure retrieval quality:** run `node scripts/retrieval-eval.mjs` (default sweep: `N=100,1000`) to measure `Recall@k`, MRR, nDCG@10, and per-arm latency over a fixed labeled query set planted into a fresh in-memory SQLite. Run before/after ranker, candidate-arm, diversity, or weight changes and diff the report. Knobs (`--strategy`, `--lambda`, `--fts-min-score`, etc.) let you A/B a config without editing code. See [`docs/guides/retrieval-eval.md`](docs/guides/retrieval-eval.md) for the flag table and how to read the output.
- **Add a memento pack:** drop the YAML file under the path named by `packs.bundledRegistryPath` (layout: `<root>/<id>/v<version>.yaml`). The format is `memento-pack/v1`; full spec and authoring flow in [`docs/guides/packs.md`](docs/guides/packs.md). The contract is [ADR-0020](docs/adr/0020-memento-packs.md). Bundled packs are data, not code — adding one does not change the engine.

When editing files under `packages/core/src/commands/**`, `packages/core/src/storage/migrations/**`, `**/*.test.ts`, or `docs/**`, the architectural rules and the pre-PR verification steps below still apply.

## Verification — run before opening a PR

You **must** run these locally before opening a PR. Do not trust CI as the first signal.

```bash
pnpm install
pnpm verify          # <!-- verify-chain:begin -->lint → typecheck → build → test → test:e2e → docs:lint → docs:reflow:check → docs:links → docs:check → format:packs:check → server-json:check<!-- verify-chain:end -->
```

`pnpm verify` mirrors the CI gate. If it passes locally, CI on the same commit should pass too (modulo OS-specific surprises in the matrix). The individual scripts (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm docs:lint`, `pnpm docs:reflow:check`, `pnpm docs:links`, `pnpm docs:check`, `pnpm format:packs:check`, `pnpm server-json:check`, `pnpm build`) remain available for tighter inner loops while iterating.

Dedicated contract and property test suites are not part of the verify chain; contract-style coverage is folded into the unit suites and property invariants are checked by example tests. `pnpm test` is the full required test gate.

### Coverage trend

In addition to the pass/fail gates above, run:

```bash
pnpm test:coverage
```

Compare the `All files` row against your starting commit. The four overall metrics (lines, branches, functions, statements) must stay equal or **increase**. Per-file drops on a file you touched are also a flag — add the missing tests rather than relax the rule. The 90% thresholds in `vitest.config.ts` are the absolute floor; this rule sets the trend.

This is non-negotiable for any change that touches `packages/*/src/`. Pure-docs and tooling-only changes are exempt.

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
- **Do not write `pack:*` tags from non-pack-install code paths.** `pack:` is a reserved tag prefix ([ADR-0020](docs/adr/0020-memento-packs.md)); user-authored writes (`memory.write`, `memory.write_many`, `memory.extract`) reject any tag starting with it. Only the `pack.install` path may stamp the canonical `pack:<id>:<version>` provenance tag.
- **Do not reference working notes in committed artefacts.** Exploratory drafts, eval reports, dogfood journals, audit prompts, and any file the author marked `DO NOT COMMIT` are private working memory. Source code, tests, comments, commit messages, and committed docs may not cite them by filename, quote from them, or link to them. The canonical record is the code itself, the ADR that justifies a decision, and the commit message in its own terms — if a rationale needs preserving, write it into one of those, not a sidecar note.

## Out of scope — do not implement

These are deliberate omissions. Do not add them. The architecture leaves the door open for additive extensions, but they are not part of the product.

- Cloud embedding providers (OpenAI, etc.) — Memento is fully local.
- Plugin / extension system. The `plugin.*` config namespace is reserved.
- Multi-user / team-scoped memory. The data model supports it; commands do not.
- HTTP / SSE transport for MCP. stdio only.
- Encryption at rest.
- Sync across machines.
- Single-binary distribution.
- TUI for browsing memory. The web dashboard (ADR-0018, `@psraghuveer/memento-dashboard`) covers the same need.

If you believe Memento needs one of these, open a [design proposal](.github/ISSUE_TEMPLATE/design_proposal.yml) — do not just implement it.

## When you are unsure

Do not invent. Ask.

- Open a draft PR with the question in the description.
- Use the [design proposal issue template](.github/ISSUE_TEMPLATE/design_proposal.yml) for non-trivial changes.
- Ask in [GitHub Discussions](https://github.com/) for general questions.

The cost of asking is small. The cost of a confidently wrong PR is large.

## For AI agents specifically

If you are running in Claude Code, install the [`memento-dev` skill](skills/memento-dev/SKILL.md) — it encodes this entire document in load-on-intent form so the rules reach you automatically when you start working on the codebase, instead of relying on you remembering to read this file. One command from a clone:

```bash
cp -R skills/memento-dev ~/.claude/skills/
```

Restart Claude Code afterwards. See [`skills/README.md`](skills/README.md#contributors-the-memento-dev-skill-claude-code-only) for verification + the differences between this contributor skill and the end-user `memento` skill.

Whether or not the skill is installed:

- **Mirror the PR template section-by-section.** When you open a PR, the body MUST contain every section from [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md): Problem, Change, Justification against the four principles, Alternatives considered, Tests, Local verification, ADR, AI involvement, Linked issues. Don't rename sections, don't drop them, don't reorder them. Mark genuinely-absent items as `N/A` with a one-sentence reason — empty is a smell. Hand-rolling a PR body that omits required sections is the single most common preventable rework.
- **Disclose your involvement** in the PR description (the PR template has an "AI involvement" section for exactly this).
- **Verify every line you generate.** Hallucinated imports, fabricated API calls, and invented config keys are the most common failure modes.
- **Run the verification commands locally.** "It looked right" is not verification.
- **Cite specific files and line numbers** when explaining your change. If you cannot, you may not have read enough context.
- **Prefer small, focused PRs.** A 200-line PR that does one thing is far easier to review than a 2000-line PR that does ten things, even if both are correct.
- **Stop and ask** if you find yourself making more than one architectural decision in a single change. That is a sign the change should be a design proposal first.

### When the user is reviewing each commit

For multi-commit work where the user is reviewing commit-by-commit — pair-programming sessions, interactive agent mode in any tool, a series of stacked PRs:

- **Do not auto-commit.** When the work for a commit is complete, run `pnpm verify` and `pnpm test:coverage`, then **pause and present a review summary** — files changed, tests added, coverage delta vs the starting commit, docs touched — and wait for explicit go-ahead before running `git commit`.
- **Docs sweep per commit.** Before asking for review, scan `docs/architecture/`, `docs/guides/`, `docs/adr/`, and package READMEs for prose that should reflect the change. Update what drifted; do not punt cleanup to a follow-up commit. The auto-generated `docs/reference/` is regenerated by `pnpm docs:generate` and is not a substitute for the prose docs.

Autonomous batch agents (cloud workers resolving an issue end-to-end, scheduled tasks, CI bots) read these conditionals and skip them — the rules only fire when a human is reviewing.

## License

Contributions are accepted under the project's [Apache-2.0 license](LICENSE). By submitting a contribution, you agree to license it under the same terms.
