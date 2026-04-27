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

## When you don't need a changeset

- Pure documentation changes (top-level `README.md`, `/docs/**`, `AGENTS.md`).
- Test-only changes that don't ship in `dist/`.
- CI / repo tooling changes.

If in doubt, run `pnpm changeset` and pick "none" for the bump type — that records the change without versioning anything.

## See also

- [Changesets docs](https://github.com/changesets/changesets)
- [`/docs/contributing.md`](../docs/contributing.md)
