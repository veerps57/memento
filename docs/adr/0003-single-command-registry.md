# ADR-0003: Single command registry, MCP and CLI as adapters

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** architecture, mcp, cli

## Context

Memento exposes operations on two surfaces today (MCP and CLI) and may add more (HTTP, library). The risk: surfaces drift. A command added to one is forgotten on the other; arguments differ; behavior subtly diverges.

## Decision

Define every command exactly once in a typed command registry in `@psraghuveer/memento-core/commands`. Each entry has a Zod input schema, a Zod output schema, a handler, and metadata. The MCP server and CLI are thin adapters that project the registry. A contract test asserts that for every registered command, both adapters expose it.

## Consequences

### Positive

- Parity between MCP and CLI is structural, not aspirational.
- New surfaces (a future HTTP transport, a library API) are new adapters, not new logic.
- Documentation is generated from the registry — `docs/reference/mcp-tools.md` and `docs/reference/cli.md` come from one source.

### Negative

- An extra abstraction. Adding a command means touching the registry, not just the surface.
- Adapter code feels mechanical — and it is. That's the point.

### Risks

- Surface-specific affordances (e.g., interactive CLI prompts) tempt people to bypass the registry. Mitigation: the contract test makes parity violations fail the build.

## Alternatives considered

### Per-surface implementations

Attractive: less ceremony. Rejected: parity drift is inevitable; this is exactly what the registry exists to prevent.

### Generate the CLI from the MCP server (or vice versa)

Attractive: less code. Rejected: each surface has surface-specific concerns (CLI rendering, MCP tool descriptions) that don't generalize cleanly.

## Validation against the four principles

1. **First principles.** Every command must exist on every surface; encode that as structure.
2. **Modular.** Surfaces are replaceable; new ones are added by writing a new adapter.
3. **Extensible.** New commands are a single registry entry plus a handler.
4. **Config-driven.** Surface behavior (e.g., enabled tools, transport choice) is configurable; command behavior is not surface-dependent.

## References

- [AGENTS.md](../../AGENTS.md) — architectural rules
- [docs/architecture/overview.md](../architecture/overview.md)
