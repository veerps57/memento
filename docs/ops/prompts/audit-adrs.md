You are auditing the Memento repo at `/Users/raghuveer/dev/memento` for drift between documentation and actual code/behavior. The user is preparing a "stale content cleanup" PR. You may be running alone or as one of several parallel agents covering different slices; cover only your slice.

## Your slice: ADRs

Files to audit:

- `docs/adr/README.md` — the ADR index.
- Every `docs/adr/0NNN-*.md` ADR file. Today there are 21 (ADR-0001 through ADR-0021); future runs may have more.
- `docs/adr/template.md` — confirm it's a clean template with no stale content. The template legitimately contains `Proposed | Accepted | Superseded by ADR-XXXX | Deprecated` placeholders; that is the template, not drift.

## What to look for, in this priority order

1. **Status drift.** Each ADR has a `Status:` line near the top. If an ADR's decision is clearly amended or superseded by a later ADR, the Status should reflect it — the precedent in this repo is `Accepted (amended by ADR-XXXX — one-sentence reason)`, e.g. ADR-0013 carries `Accepted (amended by ADR-0019 — the import side never trusts caller-supplied audit claims; the artefact format itself is unchanged)`. Cross-reference: which ADRs say "supersedes ADR-NNNN" or "amends ADR-NNNN" in their body, and is the corresponding old ADR's Status updated?

2. **Code-vs-doc drift.** When an ADR claims a config key, command name, MCP tool name, file path, or specific number — verify it against the current source:
   - Config keys: `packages/schema/src/config-keys.ts` and the auto-generated `docs/reference/config-keys.md`.
   - Commands: `packages/core/src/commands/` and the auto-generated `docs/reference/cli.md` / `docs/reference/mcp-tools.md`.
   - Error codes: `packages/schema/src/result.ts` and the auto-generated `docs/reference/error-codes.md`.
   - File paths: spot-check that referenced source files exist at the cited path.
   - Specific numbers / counts: verify against current source.

3. **Internal / session notes.** Author scratchwork that survived the merge: TODOs, FIXMEs, "(rewrite)", "(internal)", placeholder text, half-finished sentences, lorem ipsum. The template's status placeholders are not drift.

4. **Dead cross-references.** Links to other ADRs (`0NNN-...`), guides (`docs/guides/...md`), or code paths (`packages/.../foo.ts`, `packages/cli/src/lifecycle/...`). Verify every target exists with `ls` or `Read`. The repo's `pnpm docs:links` check catches the relative-link cases as a structural gate, but ADRs may carry dead links the gate doesn't see if the script's allowlist has expanded — verify by hand at audit time.

5. **Numbers and metric drift.** "5 memory kinds", "5 scope types", "20 ADRs" (will become 22, 23, …), "32 registered commands", "13 config keys". Verify against current source.

## How to report

Plain text, file by file. For each finding:

- File and line.
- Exact stale or wrong claim (quote the offending sentence or fragment).
- Correct version (or what to verify against — give the file + symbol to check).
- Severity: HIGH (factually wrong, will mislead readers) / MEDIUM (technically stale, harmless but ugly) / LOW (cosmetic / dead link).

## Critical: do not rewrite ADR decisions

`AGENTS.md`'s ADR-immutability rule protects the *decision*, not the *wording*. Cosmetic edits, typo fixes, dead-link fixes, and Status amendments (per the precedent above) are fine in-place. Substantive content rewrites are not — flag those for the maintainer to consider as a *new* ADR. In your report, distinguish:

- **"Status update required"** (fix in-place; e.g. add `Accepted (amended by ADR-XXXX — …)`).
- **"Cosmetic / link / typo"** (fix in-place).
- **"Substantive content drift"** (do NOT propose rewriting the ADR; flag only and recommend a follow-up ADR or implementation).

## Don't over-read

Skim each ADR — Status line, Decision section, any explicit code/config references, the cross-references at the bottom. ADRs are long; staying disciplined per file is the difference between a report you can act on and a report that buries the signal.

Return a structured findings report. Aim for 1500–2500 words.
