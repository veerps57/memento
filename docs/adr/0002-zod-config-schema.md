# ADR-0002: Single typed config schema as source of truth

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** config, types

## Context

Configuration is a load-bearing concern: every behavioral knob must be a `ConfigKey`. We need a way to define the config schema that:

- Validates at every layer (file, env, CLI, MCP runtime).
- Drives TypeScript types so handlers cannot drift.
- Generates user-facing documentation.
- Fails fast on invalid input with actionable errors.

Options:

- A bare TypeScript `type` with hand-written validators.
- JSON Schema with a separate TS type definition.
- A single Zod schema with `z.infer` for types and a generator for docs.

## Decision

Use a single Zod schema in `@memento/schema/config` as the source of truth. Derive TypeScript types via `z.infer`. Generate user-facing reference docs from the schema (`docs/reference/config-keys.md`).

## Consequences

### Positive

- One definition; no drift between types, validation, and docs.
- Validation errors are structured and point at the offending key.
- Adding a key is a single-file change.

### Negative

- Zod adds a runtime dependency to the schema package.
- Some advanced shapes (recursive types, sophisticated discriminated unions) are awkward in Zod; we avoid them in the config schema by design.

### Risks

- Zod major version churn. Mitigation: pinned in `@memento/schema`, exposed via a thin re-export.

## Alternatives considered

### TypeScript type + hand-written validators

Attractive: no dependency. Rejected: violates "single source of truth"; validators drift from types in practice.

### JSON Schema + TS types

Attractive: tooling-friendly. Rejected: two artifacts to keep in sync; AJV ergonomics are worse than Zod for handler code.

## Validation against the four principles

1. **First principles.** A single source of truth eliminates a class of bugs that hand-synced schemas always produce.
2. **Modular.** The schema package is the only thing handlers depend on for config types.
3. **Extensible.** New keys are additive; the reserved `plugin.*` namespace is forward-compatible.
4. **Config-driven.** This ADR exists _to_ support config-driven design.

## References

- [docs/architecture/config.md](../architecture/config.md)
