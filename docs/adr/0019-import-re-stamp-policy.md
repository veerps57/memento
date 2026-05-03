# ADR-0019: Import re-stamp policy

- **Status:** Accepted
- **Date:** 2026-05-03
- **Deciders:** veerps57
- **Tags:** portability, security, audit, import

## Context

`memento export` produces a portable JSONL artefact (ADR-0013) covering memories, audit events, conflicts, and embeddings. The original `memento import` implementation inserted every record from the artefact verbatim — the same `OwnerRef`, the same `MemoryEvent.actor`, the same `MemoryEvent.at`, the same `payload`. That made the importer trust three claims it has no way to verify:

1. The artefact's `OwnerRef` values. AGENTS.md rule 4 pins the v1 owner to `{type:'local', id:'self'}`; the import path violated that by accepting whatever the file said.
2. The artefact's `MemoryEvent.actor` and `at`. AGENTS.md rule 11 names `MemoryEvent` "the audit source of truth" — but with verbatim insert, an attacker (or a buggy export) could land events claiming any actor / any timestamp, and `memento doctor` could not tell forged events from real ones.
3. The artefact's `payload` and `evidence` JSON. `MemoryEvent.payload` is `unknown` per its variant; an artefact could stuff multi-megabyte blobs into individual records to bloat storage or game retrieval.

The audit work that flagged this (security review, May 2026) classified the violation as the largest single finding in `memento import`. The threat model has two realistic shapes:

- **Hand-crafted artefact.** A user receives a `.jsonl` from someone else (a coworker's "here's my decisions about project X", a malicious `gist`, a doctored backup). Importing today writes those memories with whatever audit history the file claims, leaving no marker that the data arrived via import.
- **Audit-log forgery.** A forged artefact carries a memory with a ULID that lexicographically precedes the user's real recent activity, plus matching events dated-back to make the forgery look chronologically plausible. The audit log on the target machine is now compromised.

Memento is single-user, local-first, and pre-1.0. The data it stores is durable working memory for AI assistants — distilled assertions, decisions, conventions. Restoring an audit log that the importer cannot vouch for is a security defect, not a feature.

## Decision

`memento import` always performs three transformations on every imported artefact, regardless of any flag:

1. **`OwnerRef` rewrite.** Every imported `Memory.owner` is replaced with `{type:'local', id:'self'}`. The artefact's claim is discarded.
2. **Re-scrub.** Every imported memory's `content`, `summary`, and (for `decision` kinds) `kind.rationale` is run through the importer's **current** scrubber rule set. The artefact's `scrubReport` is discarded; a fresh report is recorded on the synthetic event (see #3).
3. **Per-record JSON cap.** `MemoryEvent.payload`, `Conflict.evidence`, and `ConflictEvent.payload` JSON serialisations are bounded at `maxRecordBytes` (default 64 KiB) per record. Records exceeding the cap fail the import with `INVALID_INPUT` and the line number.

On top of those, `--trust-source` controls the audit chain:

- **Default (`--trust-source` absent):** the artefact's per-memory event chain is **collapsed**. For each imported memory, exactly one synthetic event is emitted:
  - `type: 'imported'` (new variant, ADR-extends `MEMORY_EVENT_TYPES`).
  - `actor`: the importer's CLI actor (`{type:'cli'}`).
  - `at`: the importer's clock at the time of import.
  - `scrubReport`: the report from the re-scrub pass over `content` / `summary` / `rationale`.
  - `payload.source`: artefact provenance (`mementoVersion`, `exportedAt`, a SHA-256 over the canonical header).
  - `payload.originalEvents`: the artefact's per-memory event chain, retained as opaque structured data for forensic value. Soft-capped at 256 entries with a truncation marker.

- **With `--trust-source`:** the artefact's `MemoryEvent` rows are inserted verbatim. The flag exists for the "I am restoring my own backup, preserve the history" case. `OwnerRef` rewrite and re-scrub still run.

The `memory.imported` variant lives alongside `created`, `confirmed`, `updated`, `superseded`, `forgotten`, `restored`, `archived`, and `reembedded` in `MEMORY_EVENT_TYPES`. Migration 0006 widens the SQLite CHECK constraint on `memory_events.type` to admit it.

## Consequences

### Positive

- The importer's audit log is structurally honest. `memory.events` always reports the truth: "this memory landed via import on $now" rather than echoing the source's actor and timestamp claims as if they happened locally.
- The forged-artefact attack class is closed. An attacker cannot back-date events, attribute them to a different actor, or claim a non-local owner.
- The "best-effort scrubber" promise from `SECURITY.md` extends across machines. An artefact authored on a host with weaker scrubber rules has its content re-redacted on the way in.
- Per-record JSON caps eliminate the storage-bloat / audit-log-pollution attack.
- The `--trust-source` carve-out preserves the legitimate "restore my own backup with full history" workflow without weakening the default.

### Negative

- `memento export → memento import` round-trip is no longer byte-equivalent in the audit log under default settings. Operators expecting "import is the inverse of export" must opt into `--trust-source`.
- The synthetic `imported` event payload carries the original event chain inline, which makes the imported `memory_events` row larger than a typical `created` event. The 256-entry soft cap bounds this.
- Adding `'imported'` to `MEMORY_EVENT_TYPES` is a forward-only schema change. Older Memento installs cannot read databases that contain imported events — but since AGENTS.md rule 1 pins migrations as forward-only and `memento` is pre-1.0, this is acceptable.

### Risks

- **Re-scrub disagreement.** A memory that scrubbed cleanly on the source machine might match a rule on the target (or vice versa). The re-scrub uses the target's rules, which is what the threat model wants — but it can change content, surprising operators who expected pure ID-preserving import. Mitigated by recording the re-scrub's `ScrubReport` on the synthetic event so the operator can diff.
- **`--trust-source` misuse.** An operator could blindly add `--trust-source` and re-introduce the forgery vector. Mitigated by documentation (the flag's help text explicitly names the threat), and by the fact that `OwnerRef` rewrite and re-scrub still run regardless.

## Alternatives considered

### Alternative A: trust everything (the original behaviour)

- **Description.** Insert all records verbatim. No transformation.
- **Why attractive.** Simplest implementation; round-trip identity for `export → import`.
- **Why rejected.** Direct violation of AGENTS.md rules 4 and 11. Audit log integrity is a stated invariant and we cannot keep an invariant we don't enforce.

### Alternative B: collapse-only (no `--trust-source`)

- **Description.** Always collapse. Drop the flag.
- **Why attractive.** Strongest default; no footgun.
- **Why rejected.** Pre-1.0 we have no real users yet, so this would be defensible — but the legitimate "restore my own backup" workflow is real. The flag is a small carve-out that documents itself; the default remains conservative.

### Alternative C: signed artefacts

- **Description.** Require artefacts to carry a cryptographic signature over the body; the importer verifies against a key the operator explicitly trusts.
- **Why attractive.** Closes the forgery vector at the source rather than papering over it at the importer.
- **Why rejected.** Out of scope for v1. No user has asked for it; key management is a substantial new surface; the re-stamp policy is sufficient on its own. Defer to a future ADR if cross-machine merging becomes a real workflow.

### Alternative D: re-stamp without `OwnerRef` rewrite

- **Description.** Collapse events, but accept the artefact's `OwnerRef`.
- **Why attractive.** Slightly less surprising for the rare multi-user-mode early adopter.
- **Why rejected.** AGENTS.md rule 4 says owners are local-self in v1. Accepting other values from an external source widens the data model in a direction we have explicitly deferred.

## Validation against the four principles

1. **First principles.** The audit log is the only structural defence against a forged event chain; trusting an importer's claims about that chain defeats the defence's purpose. Re-stamp is the minimal construct that restores the invariant.
2. **Modular.** The re-stamp policy is contained inside `importSnapshot` — the wire format (ADR-0013), entity schemas, and the rest of the import path are unchanged. Removing the policy in a future ADR would touch only `applyArtefact`.
3. **Extensible.** New `MemoryEventType` variants slot in next to `imported` without touching the policy. A hypothetical `'restored-from-backup'` event would follow the same shape.
4. **Config-driven.** `import.maxBytes` (artefact size cap, ADR-extends `safety.*`) is a `ConfigKey`. The per-record `maxRecordBytes` is currently a code-level constant; it can become a `ConfigKey` if real operators ask for it. The `--trust-source` flag is a CLI argument, not a config key, because it is per-invocation and security-relevant — accidentally setting it once in `config set` and forgetting is exactly the footgun we want to avoid.

## References

- ADR-0013 (portable export/import format).
- `AGENTS.md` rules 4 (OwnerRef), 11 (MemoryEvent as audit truth).
- `SECURITY.md` (threat model: untrusted memory content, scrubber as best-effort).
- Phase 1 of the May-2026 security hardening pass (added `'imported'` to `MEMORY_EVENT_TYPES`, migration 0006 widens the CHECK constraint).
- Phase 4 of the same hardening pass (this change).
