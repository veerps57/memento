# ADR-0007: OwnerRef is not Scope

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** data-model

## Context

Two ideas can be conflated:

- **Scope:** *where* a memory is visible (global, workspace, repo, branch, session).
- **Owner:** *who* wrote / owns a memory (a user, a team, an agent).

A naive design might fold them: "scope = owner". This breaks down quickly: a single user can have memories at all five scopes; a team-owned memory should still be filterable by scope; a tool-written memory and a user-written memory at the same scope should be distinguishable.

## Decision

Model `OwnerRef` and `Scope` as two independent dimensions. Every memory has both. Always populate `OwnerRef`, even when v1 always emits `{type:'local',id:'self'}`. The model is multi-user-ready; the v1 commands are not.

## Consequences

### Positive

- Multi-user / team support requires no data-model migration if added later.
- Audit answers "who wrote this?" cleanly, distinct from "where does it live?"
- Conflict detection can be policy-tuned by owner (e.g., user-written beats tool-inferred).

### Negative

- A field that is currently single-valued. Acceptable: the future-extension path is concrete and the cost is one column.

### Risks

- A future multi-user surface may discover the OwnerRef shape needs to change. Mitigation: the field is a discriminated union; new variants are additive.

## Alternatives considered

### Single "scope" field that subsumes owner

Rejected: confounds two questions; the audit log loses information.

### Defer OwnerRef

Rejected: a schema migration on a load-bearing column is harder than starting populated.

## Validation against the four principles

1. **First principles.** Two independent questions deserve two fields.
2. **Modular.** OwnerRef is a separate concern; resolvers and policies can depend on it without touching scope code.
3. **Extensible.** New owner types (`team`, `agent`) are additive variants.
4. **Config-driven.** Defaults for owner are configurable; v1 ships `{type:'local',id:'self'}`.

## References

- [docs/architecture/data-model.md](../architecture/data-model.md)
- [docs/architecture/scope-semantics.md](../architecture/scope-semantics.md)
