# @psraghuveer/memento-server

The MCP server adapter. Translates `@modelcontextprotocol/sdk` tool calls into invocations of the `@psraghuveer/memento-core` command registry.

This package owns the **stdio transport** and the MCP-tool surface. Anything beyond MCP-protocol concerns belongs in `@psraghuveer/memento-core` — the structural parity between the MCP adapter and the [`@psraghuveer/memento`](../cli) adapter is the entire point of ADR [0003](../../docs/adr/0003-single-command-registry.md).

`buildMementoServer` projects the `@psraghuveer/memento-core` command registry as MCP tools; `serveStdio` wires it to stdio. Used by `memento serve`.

## Session-start `instructions`

The server emits a canonical session-start teaching spine on every `initialize` handshake (ADR-0026). It covers the session-start contract: when to call `get_memory_context`, when to write, when to confirm, the `topic: value` first-line rule, supersede-not-update, the silent-plumbing rule, and the secrets prohibition.

The MCP spec defines `instructions` as an **optional** field on the initialize response — client implementations choose whether to surface the value to the assistant's system prompt. Observed behaviour across current clients varies considerably; in many implementations the field is silently dropped. Treat the spine as **best-effort future-proofing**: present on every connect, harmless on clients that drop it, may pay off as client implementations evolve.

For reliable always-on teaching, the persona snippet (the universal fallback the user pastes into the client's custom-instructions slot) is the load-bearing surface. The bundled skill carries deeper distillation rules on intent for skill-capable clients. See [`docs/guides/teach-your-assistant.md`](../../docs/guides/teach-your-assistant.md) for the three-surface walkthrough.

The text is exported as `MEMENTO_INSTRUCTIONS` from the package root. Hosts that embed `buildMementoServer` can override it via the `info.instructions` constructor option — the override replaces the spine entirely, so an operator wanting "spine + addendum" concatenates `\`${MEMENTO_INSTRUCTIONS}\\n\\n${addendum}\`` explicitly.

## MCP resource and prompt

In addition to tools, the server exposes:

- **Resource `memento://context`** — returns ranked context as JSON (equivalent to calling `memory.context`).
- **Prompt `session-context`** — accepts an optional `focus` argument. Without `focus`, it calls `memory.context` for query-less ranked retrieval. With `focus`, it calls `memory.search` using the value as the query.
