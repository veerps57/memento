# ADR-0010: MCP tool names use `verb_noun` snake_case

- **Status:** Accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Tags:** mcp, naming, dx

## Context

The command registry (ADR-0003) uses dotted `noun.verb` names — `memory.read`, `config.set`, `conflict.resolve`. The CLI surface splits the dot: `memory.read` becomes `memento memory read`. The MCP surface, until now, exposed the registry name verbatim, so MCP clients saw `memory.read`.

Two observations forced a revisit:

1. **Convention drift.** Anthropic's reference MCP servers (`filesystem`, `git`, `github`, `slack`) all use snake_case `verb_noun`: `read_file`, `write_file`, `create_issue`, `search_repositories`, `get_issue`, `list_pull_requests`. That is the corpus the model providers train tool-calling on. Tool names that match the prevailing convention get called more reliably.
2. **Surface mismatch.** CLIs are organised by resource group because users navigate them (`git --help` → `git commit --help`). MCP tools are not navigated; they are retrieved by an LLM mapping intent → call. The two surfaces want different naming shapes, and a single `name` field cannot serve both well.

A previous off-the-record discussion had landed on `verb_noun` for MCP — but the decision was never recorded and the registry name leaked through verbatim. This ADR records the decision and the mechanism that pins it.

## Decision

The MCP adapter projects each registry command through `deriveMcpName(command)` instead of using `command.name` verbatim:

- **Default rule:** `noun.verb` → `verb_noun` (`memory.read` → `read_memory`).
- **Override field:** commands declare `metadata.mcpName` to use a non-default form. Used for collection commands that want a plural noun (`memory.list` → `list_memories`) and event/history feeds that want an explicit `list_` prefix (`memory.events` → `list_memory_events`).

The CLI surface continues to use the dotted registry name (`memento memory read`). The registry name remains the single source of identity and is the field used in audit-log events, error messages, parity tests, and the CLI subcommand path.

The override list, recorded for traceability:

| Registry name | MCP name |
|---|---|
| `memory.list` | `list_memories` |
| `memory.events` | `list_memory_events` |
| `memory.set_embedding` | `set_memory_embedding` |
| `conflict.list` | `list_conflicts` |
| `conflict.events` | `list_conflict_events` |
| `conflict.scan` | `scan_conflicts` |
| `config.history` | `list_config_history` |
| `embedding.rebuild` | `rebuild_embeddings` |

All other commands derive their MCP name from the default rule.

## Consequences

### Positive

- MCP tool names match the prevailing convention used by Anthropic reference servers, which is what tool-calling models have been trained on.
- The two surfaces are free to evolve independently: a future HTTP/REST adapter can derive its own naming policy without renegotiating the registry.
- The override is a single field on `CommandMetadata`; non-default names are visible in one grep.
- Auto-generated `docs/reference/mcp-tools.md` shows the MCP name as the heading and the registry/CLI name underneath, making the mapping discoverable.

### Negative

- The MCP name and the registry name now differ for every command. Anyone reading audit-log events, error messages, or the CLI reference must translate to the MCP name when writing client config.
- One more concept (`mcpName`) on `CommandMetadata`. Mitigated by being optional.

### Risks

- **Drift between adapters.** The parity contract test (ADR-0003's slot) was previously checking `mcpNames.has(command.name)`; it now checks `mcpNames.has(deriveMcpName(command))`. If a future surface adds its own naming, the same pattern applies. The test pins it.
- **Registry shape regressing to multi-dot or no-dot names.** `defaultMcpName` throws on `noun.verb` violations. A future command that does not fit the shape must declare `mcpName` explicitly; the throw catches the shape regression at adapter build time.

## Alternatives considered

### Alternative A: keep registry name verbatim on MCP

- Attractive: zero code change, single field everywhere.
- Rejected: tool-calling reliability matters, and the prevailing convention argument is unilateral. We should not optimise for adapter implementation simplicity at the cost of how the actual users (LLMs) read the names.

### Alternative B: rename the registry to `verb_noun` and derive `noun.verb` for the CLI

- Attractive: MCP is the more-used surface in the long run; let it be the canonical form.
- Rejected: the registry name shows up in audit-log events, error messages, the parity test, and every internal log line. Changing it everywhere is a breaking change for anyone consuming the audit log; deriving the CLI form (`verb_noun` → `verb noun`?) is awkward (the CLI subcommand grouping by resource is a feature, not a transform). The CLI form has a stronger reason to be the canonical name.

### Alternative C: surface-specific name fields on every command (`name`, `cliName`, `mcpName`)

- Attractive: maximally explicit; every command states its name on every surface.
- Rejected: noise. 17 of 23 commands fit the default transform; making them state both forms triples the boilerplate for no gain. The override-only-when-needed model is strictly less work and exactly as expressive.

### Alternative D: heuristic pluralisation in `defaultMcpName`

- Attractive: would cover `memory.list` → `list_memories` without an override.
- Rejected: English pluralisation is not a function the registry should encode. Anything more elaborate than the trivial default belongs in `mcpName` overrides where the choice is visible to grep.

## Validation against the four principles

1. **First principles.** The MCP tool name's job is to be retrieved by an LLM. Match the convention the model was trained on.
2. **Modular.** The transform lives in one file (`packages/core/src/commands/mcp-name.ts`) called from one place in the MCP adapter (`buildMementoServer`). The CLI does not know about it. A future HTTP adapter can use a different policy.
3. **Extensible.** Adding a command means picking a registry name. If the default reads well, the command is done. If not, set `mcpName`. New surfaces add their own derive function.
4. **Config-driven.** N/A — internal naming, not user-facing config. Deliberately not config-driven: per-deployment MCP names would break few-shot prompting in clients.

## References

- ADR-0003 — Single command registry (the one-name source of truth this ADR refines).
- `packages/core/src/commands/mcp-name.ts` — the transform.
- `packages/core/src/commands/types.ts` — the `mcpName` field on `CommandMetadata`.
- `packages/server/src/build-server.ts` — adapter call site.
- `docs/reference/mcp-tools.md` — auto-generated, lists every MCP name and its registry equivalent.
