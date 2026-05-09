You are auditing the Memento repo at `/Users/raghuveer/dev/memento` for drift between documentation and actual code/behavior. The user is preparing a "stale content cleanup" PR. You may be running alone or as one of several parallel agents covering different slices; cover only your slice.

## Your slice: top-level docs + package READMEs + ancillary docs

Files to audit:

- `README.md` (root)
- `ARCHITECTURE.md`
- `AGENTS.md` (canonical AI-agent instructions; `CLAUDE.md` is a symlink — audit AGENTS.md)
- `CONTRIBUTING.md`
- `KNOWN_LIMITATIONS.md`
- `CODE_OF_CONDUCT.md` (low priority — usually a copy of the standard)
- `SECURITY.md`
- `.github/copilot-instructions.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `packages/schema/README.md`
- `packages/core/README.md`
- `packages/server/README.md`
- `packages/cli/README.md`
- `packages/embedder-local/README.md`
- `packages/dashboard/README.md`
- `packages/landing/README.md`
- `docs/user-stories.md`
- `docs/reference/README.md`
- `docs/ops/README.md`
- `packs/README.md`
- `packages/cli/packs/README.md` (a build-time copy of `packs/README.md`; flag if it has drifted from the source)
- `packages/cli/skills/README.md` (a build-time copy of `skills/README.md`; same)
- `.changeset/README.md`

Note: `docs/adr/README.md` is covered by the ADRs prompt. `skills/README.md` and the SKILL files are covered by the skills + landing prompt. Don't double-cover.

## What to look for, in priority order

1. **Concrete claims that contradict code.**
   - Install snippets: do they work as written? `npx @psraghuveer/memento init`, `pnpm install`, `cp -R skills/...`, etc.
   - Command examples: do the commands and flags exist?
   - Version numbers: do they match the published versions in workspace `package.json` files?
   - File paths: do they resolve?
   - Package list: do all listed packages exist? Any missing?
   - Node version requirement: matches `.nvmrc` and root `package.json` `engines` field?

2. **Stale feature claims.** "Coming soon" / "in v2" — has it shipped? "Currently broken" / "TODO" — still relevant? Mentions of removed or renamed features.

3. **Internal / session notes.** TODOs, FIXMEs, "(draft)", scratch text.

4. **Dead cross-references.** Markdown links to files that don't exist; ADR refs that don't exist. The structural `pnpm docs:links` check catches naive misses; verify any link whose surrounding prose implies a specific target.

5. **Drift between README claims and the package.json.** Package name matches; description, license, repo URL, binary names align; listed dependencies match. The `packages/cli/{packs,skills}/README.md` copies should match their workspace-root sources byte-for-byte (the copy scripts are verbatim).

6. **Outdated counts and numbers.** "21 ADRs" (will become 22, 23, …). "88 config keys" — verify against `packages/schema/src/config-keys.ts`. "5 memory kinds." "5 scope types." "16 lifecycle commands" — verify in the CLI.

7. **AGENTS.md specifically.** This is the canonical AI-agent instruction set. Verify each architectural rule still matches reality (e.g. "every state-changing operation writes an audit event" — true today?). Each "common pitfall" still applies. The "out of scope — do not implement" list is still current.

## Verify against actual code

Look at `package.json` files, `.nvmrc`, `packages/schema/src/config-keys.ts`, command registrations. Don't speculate.

## How to report

Plain text, file by file, line numbers cited. For each finding:

- File and line.
- Exact stale or wrong claim (quote the sentence or example).
- Correct version.
- Severity: HIGH / MEDIUM / LOW.

Aim for 1500–2500 words.
