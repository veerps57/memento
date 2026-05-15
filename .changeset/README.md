# Changesets

This directory drives Memento's release process. Every change that affects a published package needs a changeset.

## Workflow

1. After making your change, run:

   ```bash
   pnpm changeset
   ```

   You'll be prompted to pick affected packages and bump types (`patch` / `minor` / `major`), then write a one-line summary. The result is a markdown file in this directory.

2. Rename the generated file so it sorts chronologically.

   Changesets defaults to whimsical names (`funny-foxes-dance.md`), which makes "what's the latest changeset?" impossible to answer at a glance. Rename to:

   ```text
   .changeset/<UTC-timestamp>-<slug>.md
   ```

   where `<UTC-timestamp>` is `YYYY-MM-DDTHHMM` (minute precision is enough — multiple changesets in a single minute are rare, and the slug disambiguates anyway). Get it with:

   ```bash
   date -u +"%Y-%m-%dT%H%M"
   ```

   Example: `.changeset/2026-04-27T1949-fix-init-creates-db-parent-dir.md`. Lexicographic sort = chronological, so `ls .changeset/` and the VS Code explorer both put the newest entry last. The `changeset` CLI doesn't care about the filename — it reads any `*.md` in this directory.

3. Commit the renamed `.changeset/*.md` file alongside your change in the same PR.

4. When the PR merges to `main`, the **Release** GitHub Action opens (or updates) a "Version Packages" PR that:
   - bumps `version` fields across affected packages
   - regenerates each package's `CHANGELOG.md`
   - deletes the consumed changeset files

5. Merging the "Version Packages" PR triggers `changeset publish`, which publishes the bumped packages to npm and creates GitHub releases.

## Configuration

- `access: "public"` — packages publish to the npm public registry. All `@psraghuveer/*` scoped packages need this.
- `updateInternalDependencies: "patch"` — when a workspace package bumps, its internal dependents get a patch bump automatically. This keeps the tree consistent without forcing a major bump cascade.
- `commit: false` — Changesets does not auto-commit; the human author (or the Release Action) decides.
- `baseBranch: "main"` — used by `changeset status` to determine "what changed since".
- `linked: []`, `fixed: []` — packages version independently. We will reconsider this after v1 if independent versioning produces too much noise.

## Choosing the bump type

The bump should tell consumers the right thing about what changed in the tarball they're about to install. Two conventions apply because the packages serve two different audiences.

### Library packages (`@psraghuveer/memento-core`, `-schema`, `-embedder-local`, `-dashboard`)

Standard semver applied to the package's **public exports** — what's re-exported from `packages/<pkg>/src/index.ts`. Library consumers write code against these names; the bump tells them whether the upgrade can break their code.

| Change                                                       | Bump  |
| ------------------------------------------------------------ | ----- |
| New public export (function, type, schema, config key)       | minor |
| Change to an existing export's signature or semantics        | minor (pre-1.0 convention — see below) |
| Bug fix to an existing export, behaviour unchanged           | patch |
| Internal refactor with no observable change                  | patch (or no changeset if unobservable) |

### CLI (`@psraghuveer/memento`)

The bump reflects what someone running `npx @psraghuveer/memento` experiences when they upgrade. The CLI has no programmatic consumers; the audience is humans reading release notes.

| Change                                                                            | Bump  |
| --------------------------------------------------------------------------------- | ----- |
| Coherent feature launch — a new capability shipping across packages (the pack system, the dashboard, embeddings) | minor |
| Additive change — a new command outside a launch, a new flag, a new bundled pack or skill | patch |
| Bug fix, polish, or `packages/cli/README.md` / inline-doc updates that ship in the tarball | patch |
| Breaking change to an existing command (renamed flag, removed default, changed exit code) | minor (pre-1.0 convention) |

### Pre-1.0 convention

We are at `0.x.y`. Per semver §4, anything goes pre-1.0. The repo convention: breaking changes still bump `minor`, not `major`, so the release-notes entry is prominent. Reserve `major` for the 1.0 milestone itself.

### Worked examples from history

- **0.6.0 packs launch** (new `pack.*` commands + schema + dashboard pages + first bundled pack) — `minor` across `memento`, `memento-core`, `memento-schema`, `memento-dashboard`. Coherent launch.
- **`pack.install` hook fix** — `memento-core: patch`. Bug fix to existing surface.
- **Install-time embed + startup backfill** — `memento-core: minor`, `memento-schema: minor` (new exports: `embedAndStore`, `MementoApp.embeddingProvider`, new config keys); `memento: patch` (no new CLI commands, behavior fix only).
- **New `memento skill-path` command** (additive, not part of a launch) — `memento: patch`.
- **Three new bundled packs** (data only, no new command or schema) — `memento: patch`.

### When in doubt

Default to `patch`. The cost of an under-bump is a less-prominent release-notes entry; the cost of an over-bump is a version number that misleads consumers about what they are getting.

## When you don't need a changeset

- Pure documentation changes (top-level `README.md`, `/docs/**`, `AGENTS.md`).
- Test-only changes that don't ship in `dist/`.
- CI / repo tooling changes.

If in doubt, run `pnpm changeset` and pick "none" for the bump type — that records the change without versioning anything.

## See also

- [Changesets docs](https://github.com/changesets/changesets)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md)
