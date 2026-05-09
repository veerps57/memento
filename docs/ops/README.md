# Operations

Repo-ops, not runtime-ops. This directory holds playbooks and reusable prompts for activities the maintainer runs against the repo itself — not docs about how a *user* operates a Memento install (those live in [`docs/guides/`](../guides/), particularly [`operations.md`](../guides/operations.md)).

Today this is just the documentation-audit ritual:

- [`doc-audit.md`](doc-audit.md) — the playbook for running a periodic semantic audit of the doc surface against the actual code. Cadence, scope, how to triage findings, what's automated vs manual.
- [`prompts/`](prompts/) — five self-contained agent prompts, one per audit slice (ADRs / architecture / guides / READMEs / skills+landing). Each is ready to paste into a fresh agent invocation.

If you find yourself adding another file here, ask whether it belongs in `docs/guides/` (user-facing) or `CONTRIBUTING.md` (every-contributor flow) first. Keep `docs/ops/` for things that are explicitly maintainer-side and explicitly periodic.
