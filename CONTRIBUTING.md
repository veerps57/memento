# Contributing to Memento

Thank you for considering a contribution. This document covers how to set up the project locally, the workflow for landing a change, and the standards every PR must meet.

If you are an AI agent, **also read [`AGENTS.md`](AGENTS.md)** — it contains rules that are mandatory for any agent-authored change.

## TL;DR

1. **Discuss before you code.** For non-trivial changes, open a [design proposal issue](.github/ISSUE_TEMPLATE/design_proposal.yml) before writing code. Trivial changes can go straight to a PR.
2. **One change per PR.** A PR does one thing. Architectural change, behavioral change, refactor, and dependency bump are four different PRs.
3. **Justify against the four principles.** First principles. Modular. Extensible. Config-driven. Every PR description must address these.
4. **Tests are not optional.** New behavior needs a unit test. New invariants need a property test. New commands need a contract test. New migrations need an integration test.
5. **Run the full verification locally before pushing.** CI is a safety net, not a development server.

## Where to start

If you are looking for a low-friction first contribution, these are good entry points — none require a design proposal:

- **Doc fixes.** Typos, broken links, stale CLI/MCP names, examples that no longer match the current surface. Cross-check against [`docs/reference/cli.md`](docs/reference/cli.md) and [`docs/reference/mcp-tools.md`](docs/reference/mcp-tools.md), which are auto-generated from the registry.
- **Add a config recipe.** [`docs/architecture/config.md`](docs/architecture/config.md) and [`docs/reference/config-keys.md`](docs/reference/config-keys.md) describe the surface; concrete recipes for tuning a specific behavior (decay aggressively, surface conflicts in search, broaden scrubber rules) are always welcome.
- **Improve an error message.** Find a `ResultErr` in `packages/core/src/` whose message is terse or unhelpful and tighten it. Errors are the contract surface for AI assistants — clarity here compounds across every client.
- **Expand [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md).** If you tripped over a limitation that was not documented, add it. Distinguish "not yet" from "intentionally not."
- **Add a missing test case.** Coverage is gated at 90/90/90/90 (lines, branches, functions, statements) per [`vitest.config.ts`](vitest.config.ts), but specific edge cases (empty input, scope edge cases, conflict ties) are good targeted contributions.

For larger changes, open a [design proposal issue](.github/ISSUE_TEMPLATE/design_proposal.yml) first — it is faster than rewriting after review.

Before filing a bug, scan [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md) — many "weird behaviors" are documented v1 trade-offs.

## The four guiding principles

These are the lens through which every change is evaluated. The PR template asks you to address each one explicitly.

1. **First principles.** What problem does this solve? Could a simpler construct solve it? Why is it not "we usually do it this way"?
2. **Modular.** Is the new code replaceable without rewriting the rest? Does it depend on private internals of another module?
3. **Extensible.** Can a new variant be added later without changing this code? Are the extension points obvious?
4. **Config-driven by the user.** Is every behavioral knob a `ConfigKey`? Are there magic numbers in the diff?

## Local setup

### Prerequisites

- Node.js 22.11+ (the version pinned in [`.nvmrc`](.nvmrc) is the supported version; `nvm use` / `fnm use` will pick it up).
- pnpm 10.x. The repository pins `packageManager: pnpm@10.30.2` in [`package.json`](package.json), so `corepack enable` is enough — corepack will install the right version automatically.
- A C/C++ toolchain for compiling `better-sqlite3` (Xcode command-line tools on macOS, build-essential on Debian/Ubuntu).
- Git ≥ 2.40.

### First-time setup

```bash
# If you have write access to the repo:
git clone https://github.com/veerps57/memento
# Otherwise, fork on GitHub first, then:
git clone https://github.com/<your-fork>/memento

cd memento
corepack enable                  # one-time, picks up the pnpm version from package.json
pnpm install --frozen-lockfile   # mirrors CI; fails fast if pnpm-lock.yaml drifts
pnpm typecheck
pnpm test
```

If `pnpm install` fails on `better-sqlite3`, you are missing the C toolchain.

### Running the MCP server locally

`memento serve` is the supported entry point. From a clone:

```bash
pnpm dev:server
```

`pnpm dev:server` builds the four packages the CLI needs (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`, `@psraghuveer/memento-server`, `@psraghuveer/memento`) and then runs `node packages/cli/dist/cli.js serve`. Pass `--db <path>` after the script name (e.g. `pnpm dev:server --db ./tmp.db`) or set `MEMENTO_DB` in the environment to point at a different database file. With neither set, Memento uses the XDG default (e.g. `~/.local/share/memento/memento.db`).

If you'd rather run the build and the server in two steps — for example, to leave a long-running server attached to a particular database file — the underlying invocation is:

```bash
pnpm -F @psraghuveer/memento-schema -F @psraghuveer/memento-core -F @psraghuveer/memento-server -F @psraghuveer/memento build
node packages/cli/dist/cli.js serve --db ./memento.db
```

### Running the dashboard locally

The dashboard package (`@psraghuveer/memento-dashboard`) ships two artefacts: a Hono server bundle (`dist/`) and a Vite-built React SPA (`dist-ui/`). For a quick look against your real store:

```bash
pnpm dev:dashboard
```

That builds the four packages the dashboard needs (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`, `@psraghuveer/memento-server`, `@psraghuveer/memento-dashboard`) plus the CLI, then launches `memento dashboard` against your default `MEMENTO_DB`. Same shape as `pnpm dev:server`. `Ctrl-C` stops it.

For UI iteration with hot module reload, use the two-terminal workflow:

```bash
# terminal A — backend on the fixed port the Vite proxy expects
node packages/cli/dist/cli.js dashboard --port 4747 --no-open

# terminal B — Vite dev server (HMR for the SPA)
pnpm -F @psraghuveer/memento-dashboard dev
```

Then open `http://localhost:5173` in your browser. Vite proxies `/api/*` to the backend on `:4747`. UI edits hot-reload instantly; backend edits require a Terminal A restart.

The user-facing walkthrough (what each view shows, the Cmd-K command palette, the inline config editor, troubleshooting) lives in [`docs/guides/dashboard.md`](docs/guides/dashboard.md). The architectural decision is [ADR-0018](docs/adr/0018-dashboard-package.md).

### Install the contributor skill (Claude Code only)

If you use [Claude Code](https://www.anthropic.com/claude-code) for development, install the bundled `memento-dev` skill so the four guiding principles, the 14 architectural rules, the verification chain, and the common pitfalls auto-load on intent match for any change you make in the repo:

```bash
cp -R skills/memento-dev ~/.claude/skills/
```

Restart Claude Code. The skill triggers on prompts like "add a command", "add a config key", "add a migration", or any edit under `packages/`. It is the load-on-intent companion to this `CONTRIBUTING.md` and to [`AGENTS.md`](AGENTS.md) — same content, different delivery. Verify it is loaded by asking your assistant in this checkout: *"What's the rule about hardcoded behavioral constants?"* — the skill should fire and the assistant should answer with rule 2.

The skill is optional: every rule it surfaces also lives in `AGENTS.md`. If you don't use Claude Code, read [`AGENTS.md`](AGENTS.md) directly — it's the source of truth either way. See [`skills/README.md`](skills/README.md) for installation details and the equivalent end-user `memento` skill (a different artifact for AI assistants *using* Memento, not contributors *editing* it).

## Workflow

### 1. Open an issue first (for non-trivial changes)

If your change touches the data model, the public MCP/CLI surface, the config schema, the storage layer, or any architectural decision — open a [design proposal issue](.github/ISSUE_TEMPLATE/design_proposal.yml) before writing code. The template forces ADR-style thinking and lets reviewers catch architectural drift early.

Trivial changes (typos, doc fixes, single-file refactors with no behavior change) can skip this step.

### 2. Branch

Branch from `main`. Use a descriptive branch name:

```bash
git checkout -b docs/improve-getting-started
git checkout -b feat/add-memory-pin-command
git checkout -b fix/scrubber-handles-empty-input
```

### 3. Code

Follow the architectural rules in [`AGENTS.md`](AGENTS.md). The most important ones:

- Every command goes in the registry, never bypassing it.
- Every behavioral constant goes in `ConfigKey`, never inline.
- Every state change emits a `MemoryEvent` or `ConfigEvent`.
- Use Kysely repositories. Do not write raw SQL outside of migrations.
- Migrations are append-only. Never edit a shipped migration.

### 4. Test

| Kind        | Location                                | When required                                              |
| ----------- | --------------------------------------- | ---------------------------------------------------------- |
| Unit        | `packages/*/test/**/*.test.ts`          | Always for new behavior.                                   |
| Integration | `packages/core/test/`                   | When you touch storage, migrations, or MCP.                |
| Migration   | `packages/core/test/storage/`           | When you add a migration.                                  |
| End-to-end  | `packages/*/test/e2e/**/*.e2e.test.ts`  | When you change CLI startup, MCP wiring, or the binary.    |

Contract-style coverage for the command registry is folded into the unit suites. Property invariants are checked by example tests in the unit suites.

Unit, integration, and migration tests are colocated under each package's `test/` directory and run together via:

```bash
pnpm test                              # full vitest run (excludes e2e)
pnpm vitest run packages/core/test/storage   # just the migration tests
pnpm vitest run packages/cli/test            # just the CLI tests
pnpm test:e2e                          # build + spawn the CLI for MCP-stdio smoke tests
```

End-to-end tests spawn the *built* CLI as a child process and drive it over MCP stdio — they catch failure modes (bundler drops, missing peer deps, schema/registry desyncs) that no in-process test can. They live in dedicated `test/e2e/**` folders and are excluded from `pnpm test` so the inner-loop suite stays fast; `pnpm test:e2e` builds first and then runs them, and `pnpm verify` chains both.

### 5. Verify locally

The canonical pre-push command mirrors the CI gate:

```bash
pnpm verify
```

`pnpm verify` runs, in order: <!-- verify-chain:begin -->lint → typecheck → build → test → test:e2e → docs:lint → docs:reflow:check → docs:links → docs:check → format:packs:check → server-json:check<!-- verify-chain:end -->. If it passes locally, CI on the same commit should pass too (modulo OS-specific surprises in the matrix).

The individual steps are also available for tighter loops while iterating:

```bash
pnpm lint               # biome check (lint + format)
pnpm typecheck          # tsc --noEmit
pnpm test               # full vitest run
pnpm docs:lint          # markdownlint across all *.md
pnpm docs:reflow:check  # enforce one-paragraph-per-line markdown (long-line / soft-wrap)
pnpm docs:check         # verify docs/reference/ is in sync with the registry
```

If `docs:reflow:check` fails, run `pnpm docs:reflow` to apply the fix. The convention (long-line, no hard-wrap; one paragraph per line, editor soft-wraps) is documented in `.markdownlint-cli2.jsonc` and enforced by [`scripts/reflow-md.mjs`](scripts/reflow-md.mjs).

If you change anything that the doc generator cares about (a command's metadata, a `ConfigKey`, an error code), regenerate and commit:

```bash
pnpm docs:generate
git add docs/reference/
```

### 6. Open the PR

Mirror the [PR template](.github/PULL_REQUEST_TEMPLATE.md) section-by-section. The body must contain all nine sections, in order, without renaming or dropping any:

1. **Problem** — state it in your own words.
2. **Change** — one precise paragraph; a reviewer should understand the change from this alone.
3. **Justification against the four principles** — address each explicitly. "N/A" requires a sentence explaining why.
4. **Alternatives considered** — short description, why attractive, why rejected. Empty is a smell.
5. **Tests** — which kinds cover the change, or `N/A` with a reason.
6. **Local verification** — confirm you ran `pnpm verify` and `pnpm docs:generate` if generated docs changed.
7. **ADR** — required if you make a load-bearing decision (public surface, data model, scope semantics, top-level dependency, a default that affects retrieval/decay/conflict, or reversing a prior decision).
8. **AI involvement** — required for transparency, whether or not AI was used.
9. **Linked issues** — `Closes #N` / `Refs #N`, or empty if none.

Hand-rolling a PR body that omits or renames sections is the single most common preventable rework. PRs that skip the template structure will be asked to fill it in before review.

### 7. Review

Expect substantive review. Architectural disagreements are resolved in the PR thread or, if needed, by writing a new ADR. "I prefer it this way" is not a sufficient justification on either side.

CI must be green and the PR must have at least one approval before merge. Squash-merge is the default; the squashed message becomes the changelog entry, so make it good.

## Commit message style

Conventional Commits. The type prefix matters because the changelog is generated from it.

```text
feat(server): add memory.write_many command
fix(core): preserve confidence on supersede when not provided
docs(architecture): clarify decay function
chore(deps): bump @modelcontextprotocol/sdk to 1.x
test(scrubber): cover empty-input edge case
refactor(cli): extract render helpers
```

Body should explain **why**, not what. The diff already shows what.

For PRs that warrant a changelog entry, add a [Changeset](https://github.com/changesets/changesets) in the same PR:

```bash
pnpm changeset
```

Then **rename the generated file** so it sorts chronologically:

```text
.changeset/<UTC-timestamp>-<slug>.md     # YYYY-MM-DDTHHMM-<slug>.md
```

Get the timestamp with `date -u +"%Y-%m-%dT%H%M"`. Example: `.changeset/2026-04-27T1949-fix-init-creates-db-parent-dir.md`. The default whimsical names (`funny-foxes-dance.md`) make "what's the latest changeset?" unanswerable; the timestamp prefix fixes that. The CLI doesn't care about the filename — it reads any `*.md` in `.changeset/`.

### Picking the bump type

Library packages (`@psraghuveer/memento-core`, `-schema`, `-embedder-local`, `-dashboard`) follow standard semver on their public exports: `minor` for new exports or signature changes, `patch` for bug fixes and internal refactors. The CLI (`@psraghuveer/memento`) bumps `minor` only for a coherent feature launch shipping across packages; everything else — additive commands outside a launch, new bundled packs or skills, polish, README updates that ship in the tarball — is `patch`. Pre-1.0, breaking changes still bump `minor` (not `major`) so the release-notes entry is prominent. When in doubt, `patch`.

The full framework, with worked examples drawn from past releases, is in [`.changeset/README.md`](.changeset/README.md#choosing-the-bump-type).

## Releasing

Releases are automated end-to-end. You should never need to run `npm publish`, `git tag`, or `pnpm publish` by hand.

### How it works

The pipeline is [`.github/workflows/release.yml`](.github/workflows/release.yml), driven by [Changesets](https://github.com/changesets/changesets):

1. Every PR that changes published behaviour adds a changeset via `pnpm changeset`. Changesets are committed to `.changeset/`.
2. When a PR with changesets merges to `main`, the workflow opens (or updates) a **"Version Packages" PR**. That PR bumps every affected package, regenerates `CHANGELOG.md` files, and consumes the changesets.
3. When the "Version Packages" PR is merged, the same workflow runs `pnpm release`, which:
   - publishes each changed package to npm with `--access public` and provenance,
   - pushes per-package git tags (e.g. `@psraghuveer/memento@0.1.0`),
   - and pushes a single umbrella `v<X.Y.Z>` tag, keyed off the CLI package version (what `memento --version` reports).

### What you do

- Author PRs normally. Add a changeset (`pnpm changeset`) for any change that affects published packages. No changeset = no release.
- Review and merge the auto-generated **"Version Packages"** PR when you want to cut a release. That single merge is the release trigger.
- Watch the `Release` workflow run on `main` after the merge. If it succeeds, the release is on npm and tagged.

### Required repository configuration

- `NPM_TOKEN` secret: an npm **automation** token for `psraghuveer` with publish access to `@psraghuveer/*`. Automation tokens bypass 2FA, which is what makes the publish step run unattended.
- `id-token: write` permission on the workflow (already set) — enables npm provenance via OIDC.

## Architecture Decision Records

Significant architectural decisions are recorded as ADRs in [`docs/adr/`](docs/adr/). If your change overturns or modifies an existing ADR, add a new ADR that supersedes it — never edit a historical ADR. Use [`docs/adr/template.md`](docs/adr/template.md) as the starting point.

A change needs an ADR if it:

- Changes the public MCP or CLI surface.
- Changes the data model or scope semantics.
- Adds or removes a top-level dependency.
- Changes a load-bearing default in the config.
- Reverses a previous decision.

## Deprecating a registry command

When you rename or supersede a registry command, set `metadata.deprecated = "<rationale + replacement + target removal release>"` on the old command rather than deleting it. Per [ADR-0015](docs/adr/0015-deprecation-policy.md), the deprecated command must:

- Stay registered on every surface it shipped on for at least one full minor release.
- Keep its existing input/output schemas and error semantics unchanged for that window.
- Carry a rationale string that names the replacement (when one exists) and the planned removal release (e.g. `"use memory.write_many instead; removed in v2.0.0"`).

The MCP description and the generated CLI / MCP reference docs project the deprecation note automatically. The contract test [`packages/cli/test/deprecation.contract.test.ts`](packages/cli/test/deprecation.contract.test.ts) pins this behaviour for every command that carries the flag.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). Include:

- Memento version (`memento --version`).
- Output of `npx @psraghuveer/memento doctor` (with `--format json` for the full diagnostic).
- Steps to reproduce.
- Expected vs. actual behavior.
- Relevant config (with secrets redacted).

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](SECURITY.md) for the disclosure process.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating, you agree to abide by it.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 license](LICENSE).
