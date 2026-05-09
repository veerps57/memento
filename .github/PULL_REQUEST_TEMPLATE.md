<!--
Thanks for the contribution. Please fill out every section.
PRs that skip the template will be asked to fill it in before review.

Required reading before opening this PR:
- AGENTS.md
- CONTRIBUTING.md
- The ADRs in docs/adr/ that touch the area you are changing
-->

## Problem

<!-- State the problem in your own words. What concrete need does this address? -->

## Change

<!-- One paragraph. Be precise. A reviewer should understand the change from this alone. -->

## Justification against the four principles

<!-- Address each. Brief is fine; "N/A" requires a sentence explaining why. -->

- **First principles.**
- **Modular.**
- **Extensible.**
- **Config-driven.**

## Alternatives considered

<!-- For each: short description, why it was attractive, why it was rejected.
     Empty list is a smell — every real change has alternatives. -->

## Tests

<!-- Which tests cover this change? -->

- [ ] Unit
- [ ] Integration
- [ ] Migration
- [ ] End-to-end
- [ ] N/A — explain why:

## Local verification

<!-- Confirm you have run, locally and successfully: -->

- [ ] `pnpm verify` (<!-- verify-chain:begin -->lint → typecheck → build → test → test:e2e → docs:lint → docs:reflow:check → docs:links → docs:check → format:packs:check<!-- verify-chain:end -->)
- [ ] `pnpm docs:generate` committed if generated docs changed

## ADR

<!-- If this PR makes a load-bearing decision (changes the public surface, the data model,
     scope semantics, a top-level dependency, a load-bearing default, or reverses a previous
     decision), it must include an ADR in docs/adr/. -->

- [ ] An ADR is required and is included in this PR.
- [ ] An ADR is required and exists already (link below).
- [ ] No ADR required (explain why):

## AI involvement

<!-- Honest disclosure helps reviewers. AI assistance is welcome; opaque AI assistance is not. -->

- [ ] No AI assistance.
- [ ] AI assistance for boilerplate / drafting only.
- [ ] AI authored substantial portions. I have verified every line.

## Linked issues

<!-- "Closes #123" / "Refs #456" -->
