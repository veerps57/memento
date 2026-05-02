# ADR-0015: Deprecation policy for registry commands

- **Status:** Accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Tags:** registry, surface-stability, contract

## Context

The command registry is the source of truth for both the MCP and CLI surfaces (ADR-0003). `Command.metadata.deprecated` exists as a typed field ([packages/core/src/commands/types.ts](../../packages/core/src/commands/types.ts)) and the docs/MCP/CLI projections all render it (`render-cli.ts`, `render-mcp-tools.ts`, `build-server.ts`). What was missing was a *policy* — when `deprecated` is set, what does a caller actually get, and for how long? Without that, a deprecation is indistinguishable from a breaking rename, and downstream agents have no basis to plan a migration window.

P2.1 ("a small, learnable surface") asks for the answer to be a contract, not a convention.

## Decision

A registry command marked `metadata.deprecated = "<rationale + replacement>"` is a **contract**, not a soft hint. For at least one full minor release after the field is set, the deprecated command MUST:

1. Remain registered on every surface it was registered on before (no surface narrowing).
2. Continue to validate inputs and return outputs against the same Zod schemas it shipped with — no behaviour change, no error code change, no rename.
3. Be discoverable as deprecated on every surface: - **MCP** — the tool description in `tools/list` is suffixed with `(deprecated: <rationale>)` so the deprecation appears verbatim in any MCP client's tool picker. - **CLI** — `docs/reference/cli.md` (generated) renders a `**Deprecated:** <rationale>` bullet under the command entry; `memento <cmd> --help` (when the future help layer ships) reads the same metadata. - **Generated docs** — `docs/reference/mcp-tools.md` renders the same `**Deprecated:** <rationale>` bullet.

The deprecation rationale string MUST name the replacement when one exists ("use `memory.write_many` instead"). When no replacement exists, it MUST state why and what the caller's recourse is.

A deprecated command may be removed in the next major release (v2.0.0 from a v1.x deprecation, etc.). The removal is itself a breaking change and follows the standard semver expectations.

This policy is enforced by the contract test [`packages/cli/test/deprecation.contract.test.ts`](../../packages/cli/test/deprecation.contract.test.ts). The test pins, for any command with `metadata.deprecated` set:

- it is resolvable on every surface it declares (no registry-side filter strips it);
- the MCP tool description carries the `(deprecated: …)` suffix;
- the CLI reference renderer produces a `**Deprecated:**` line for it.

A fixture deprecated command exercises all three checks even when no real command in v1 carries the flag.

## Consequences

### Positive

- A single source of truth for "is this command going away?": the metadata bit. No separate changelog incantations, no out-of-band warnings, no surface-by-surface drift.
- Downstream agents (the AI-assistant population this surface is built for) get the deprecation note in the same place they read the tool list, which is the only signal that scales.
- The contract test makes the policy mechanical. A future refactor that strips deprecated commands from one surface fails the build.

### Negative

- One minor-release-cycle of carrying code that has a successor is the cost — paid in indirection, not in correctness.
- The deprecation note lives in metadata, not in the schema, so a schema-level breaking change to a deprecated command is technically representable. The policy forbids it; the test asserts schema stability across the deprecation window only to the extent that it asserts the command is still resolvable. Stronger schema-pinning is left to per-command contract tests when warranted.

### Risks

- **Inflation.** "Mark as deprecated, never remove" is the natural attractor. Mitigation: every `deprecated` annotation must reference a target removal release in the rationale string ("removed in v2.0.0"). Reviewers enforce this.
- **Unread metadata.** If a caller never reads tool descriptions, the deprecation is invisible until removal. Mitigation: tool descriptions are the standard MCP signal; callers that ignore them are outside the contract.

## Alternatives considered

### Alternative A: Per-call warning channel

Emit a structured `warnings: [...]` array on the response of every deprecated command. Attractive because the deprecation becomes impossible to miss at runtime. Rejected because every command's output schema would need a `warnings` slot, the warnings would have to round-trip through both adapters, and the signal duplicates what `tools/list` already provides.

### Alternative B: Hard-fail with an opt-in flag

Make every deprecated command return `INVALID_INPUT` unless the caller passes `acknowledgeDeprecated: true`. Attractive because it forces migration. Rejected because it is functionally a breaking change disguised as a deprecation — the grace period is the whole point.

### Alternative C: No policy, just the field

Leave `metadata.deprecated` as a hint with no contract. Rejected because the gap analysis (P2.1) asked for the stability sub-clause to be a contract, and an unenforced hint isn't one.

## Validation against the four principles

1. **First principles.** A deprecation is a promise about future behaviour. Promises that are not testable are not contracts. The policy makes the promise testable.
2. **Modular.** The policy lives in the registry's metadata shape; the adapters and the docs renderer already project the field; the contract test pins the projection. No new subsystem.
3. **Extensible.** Future surfaces (HTTP/SSE in v2) are added to the contract test the same way they're added to ADR-0003 parity: one row in the matrix.
4. **Config-driven.** No new `ConfigKey`. Deprecation is a command-author choice expressed in code, not an operator knob.

## References

- ADR-0003: Single command registry
- ADR-0010: MCP tool naming
- `packages/core/src/commands/types.ts` — `metadata.deprecated`
- `packages/cli/test/deprecation.contract.test.ts`
