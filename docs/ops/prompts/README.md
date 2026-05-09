# Audit prompts

Five self-contained agent prompts. One per slice of the doc surface. Each is ready to paste into a fresh Claude Code Agent invocation; the file content IS the prompt.

The orchestration workflow lives in [`../doc-audit.md`](../doc-audit.md) — what to run, when, how to triage. This directory is the prompt library.

| File | Slice |
|---|---|
| [`audit-adrs.md`](audit-adrs.md) | `docs/adr/` — the 21 ADRs plus the index and template. |
| [`audit-architecture.md`](audit-architecture.md) | `docs/architecture/` — 10 technical deep-dives. |
| [`audit-guides.md`](audit-guides.md) | `docs/guides/` — 9 user-facing how-to docs. |
| [`audit-top-level-and-readmes.md`](audit-top-level-and-readmes.md) | Top-level docs + every package README + ancillary docs. |
| [`audit-skills-and-landing.md`](audit-skills-and-landing.md) | Skill bundles + landing-page copy. |

If you change a prompt, run the corresponding agent against a known-good HEAD first to confirm the prompt still produces a useful, structured report; agent prompts are surprisingly easy to break by tightening one instruction past the inflection point.
