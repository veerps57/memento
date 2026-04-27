# ADR-0008: No relatedTo / generic graph edges

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** data-model

## Context

It is tempting to add a generic `relatedTo: MemoryId[]` field (or a separate edge table) so memories can be linked. This opens questions immediately:

- Are edges typed? If so, by what taxonomy?
- Are edges directed? Symmetric? Transitive?
- Who decides when to link? The user? The agent? Inferred?
- How are edges retrieved? Walked? Surfaced in search?

Answering these honestly produces a graph database. Answering them poorly produces a footgun.

## Decision

The only relationship between memories is **supersession**. There is no `relatedTo`, no generic edge table, no link types. If a concrete use case demands relationships in the future, an ADR will introduce them with the modeling questions answered first.

## Consequences

### Positive

- A small, sharp data model.
- No premature abstraction.
- Supersession alone covers the most-needed case ("this replaces that").

### Negative

- Users wanting "see also" links must use tags as a proxy.

### Risks

- Demand may grow for relationships. Mitigation: the door is open; an ADR can introduce them when the use case is concrete.

## Alternatives considered

### Untyped `relatedTo: MemoryId[]`

Attractive: simple. Rejected: untyped relationships are a tag system in disguise; tags do this better.

### Typed edge table

Attractive: future-proof. Rejected: the type taxonomy is the hard problem; choosing it without a use case is guessing.

## Validation against the four principles

1. **First principles.** No construct exists without a justified need. Edges fail this test today.
2. **Modular.** Less code = more replaceable.
3. **Extensible.** Adding edges later is additive; not adding them now is reversible.
4. **Config-driven.** N/A — this ADR removes a knob rather than adds one.

## References

- [docs/architecture/data-model.md](../architecture/data-model.md)
