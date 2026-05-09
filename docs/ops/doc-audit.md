# Documentation audit

Memento ships a substantial doc surface — 70+ markdown files spanning the README, ARCHITECTURE, AGENTS, ADRs, architecture deep-dives, guides, package READMEs, the landing page, and the skill bundles. Drift between those docs and the actual code is the failure mode this playbook addresses.

Drift comes in two flavours, and they want different tools.

**Structural drift** is mechanical and should never reach a PR — broken internal links, references to config keys that don't exist, references to commands that were renamed, the `pnpm verify` chain text drifting across the four files that quote it. Memento gates structural drift in `pnpm verify` via three checks:

- `pnpm docs:links` — every relative markdown link resolves to a file that exists. Files that load with the user's repo as cwd at runtime (the `memento-dev` skill in particular) opt in to repo-root-relative resolution by adding `<!-- doc-links: resolve-from-repo-root -->` near the top.
- `pnpm docs:check` — auto-generates the four reference files (`cli.md`, `mcp-tools.md`, `config-keys.md`, `error-codes.md`) plus the JSON Schema; substitutes the `pnpm verify` chain text into the `<!-- verify-chain:begin -->`/`<!-- verify-chain:end -->` markers in AGENTS.md / CONTRIBUTING.md / `.github/copilot-instructions.md` / `.github/PULL_REQUEST_TEMPLATE.md`; and walks every `.md` file looking for `<known-namespace>.<word>` patterns that aren't registered config keys, registered commands, memory/conflict event types, namespace prefixes of registered keys, or recognised file extensions. Files with `<!-- phantom-keys: ignore-file -->` are exempt; ADRs are exempt by directory because they substantively discuss alternatives.
- `pnpm docs:lint` and `pnpm docs:reflow:check` — markdownlint and one-paragraph-per-line reflow.

If a fix would have been caught by a structural check, the right move is to land it (and improve the check if it slipped through). The structural-check tier should always be the first line of defence.

**Semantic drift** is everything else — fabricated APIs, stale recommendations, "this is how it works" prose that no longer matches the code, ADR Status amendments after a later ADR amends them, ADR cross-references that should have been updated when the target was renamed, examples that compile but no longer do what the surrounding text claims. This needs reasoning, not regex. The structural checks won't catch it. Running an LLM against every PR for this is wasteful — the per-PR delta is too small. The right cadence is **quarterly** (every 3 months) plus **on-demand for big surface changes** (e.g. shipping a new ADR that supersedes an old one, or after a v0.x → v1 release that touches the public surface).

## What the semantic audit checks for

Five slices, one prompt each, runnable in parallel.

| Slice | Coverage |
|---|---|
| **ADRs** ([`prompts/audit-adrs.md`](prompts/audit-adrs.md)) | Status drift (does the ADR's Status reflect later supersession or amendment?), code-vs-doc drift on concrete claims, dead cross-references, stale numbers, internal/session notes. |
| **Architecture** ([`prompts/audit-architecture.md`](prompts/audit-architecture.md)) | The 10 deep-dive docs under `docs/architecture/`. The highest-drift surface — hand-maintained while code evolves. Concrete claims against `packages/schema/`, `packages/core/`. |
| **Guides** ([`prompts/audit-guides.md`](prompts/audit-guides.md)) | The 9 user-facing how-to docs under `docs/guides/`. Every command example, every flag, every default value matters; a wrong example wastes user time. |
| **Top-level + READMEs** ([`prompts/audit-top-level-and-readmes.md`](prompts/audit-top-level-and-readmes.md)) | `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `KNOWN_LIMITATIONS.md`, `SECURITY.md`, the per-package READMEs, the GitHub-folder docs, the `.changeset/` README. |
| **Skills + landing** ([`prompts/audit-skills-and-landing.md`](prompts/audit-skills-and-landing.md)) | The two SKILL files (and their CLI mirrors), `packages/landing/src/{App.tsx,comparison.ts,faq.ts,howto.ts}`, the persona-snippet duplication that App.tsx flags as needing to stay in sync with `docs/guides/teach-your-assistant.md`. |

The slices are sized so each fits in one agent's context comfortably and so the slices don't overlap. Run the five in parallel; each returns a structured findings report.

## How to run it

The intended workflow is human-driven and chat-based, not scripted. Sit at a Claude Code session, kick off the five agents in parallel, triage what comes back.

1. Open a fresh Claude Code session at the repo root.
2. Spawn the five sub-agents in parallel — one Agent tool call per prompt file. Each prompt is self-contained: paste the file contents into the agent's prompt argument, then send.
3. Wait. Each agent reads its slice, cross-references against the code, and returns a findings report.
4. Triage as the reports land. Fix HIGH and MEDIUM in a single batched commit on a branch; flag substantive content drift (e.g. an ADR that promised a command that was never shipped) for separate decisions.

Approximate cost per audit run: ~300–500K input tokens across the five agents, depending on slice size. That is real money but cheap compared to a wrong recommendation reaching a user.

## How to triage findings

Each prompt asks the agent to tag every finding HIGH / MEDIUM / LOW. Default response:

| Severity | What it means | What to do |
|---|---|---|
| **HIGH** | Factually wrong; will mislead a reader. A user running the example will fail. A claim contradicts what the code does. A cross-reference is dead. | Fix in the same audit-cleanup PR. |
| **MEDIUM** | Technically stale, but not actively misleading. A number is off, a feature is described in the past tense, a doc references a removed alternative. | Fix in the same PR if cheap; skip otherwise and flag in the PR description for follow-up. |
| **LOW** | Cosmetic: dead link to a moved file, typo, wording awkwardness, ADR-internal historical context that's now slightly off. | Fix only if you're already in the file. |

**Do not let an agent rewrite a substantive ADR claim.** ADR immutability protects the *decision*. Cosmetic edits, link fixes, and Status amendments (per the precedent in ADR-0013 → ADR-0019: `Accepted (amended by ADR-XXXX — short reason)`) are fine in-place. Substantive content drift in an ADR — for example an ADR that promised a command that was never shipped — is a signal for a *new* ADR amending or superseding the old one, not for rewriting history.

## What not to do

- **Don't run the semantic audit on every PR.** Per-PR delta is too small for the agent to find anything; you're paying tokens for noise.
- **Don't skip the structural tier.** If `pnpm verify` is failing on `docs:check` or `docs:links`, the answer is to fix the structural check, not to add an opt-out marker. Those checks pay for themselves; weakening them makes the next semantic audit larger.
- **Don't try to merge the five slices into one agent.** They were sized deliberately. One mega-agent loses precision on the per-slice instructions and is harder to budget against context limits.
- **Don't use the audit to ship features.** If a finding turns into "and while we're here, let's also add X," X goes in a separate PR. The audit-cleanup PR's value is its scope.

## When in doubt

Ask. The cost of a confidently-wrong audit fix is larger than the cost of a doc that drifted for one more quarter.
