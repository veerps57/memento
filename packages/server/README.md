# @psraghuveer/memento-server

The MCP server adapter. Translates `@modelcontextprotocol/sdk` tool calls into invocations of the `@psraghuveer/memento-core` command registry.

This package owns the **stdio transport** and the MCP-tool surface. Anything beyond MCP-protocol concerns belongs in `@psraghuveer/memento-core` — the structural parity between the MCP adapter and the [`@psraghuveer/memento`](../cli) adapter is the entire point of ADR [0003](../../docs/adr/0003-single-command-registry.md).

`buildMementoServer` projects the `@psraghuveer/memento-core` command registry as MCP tools; `serveStdio` wires it to stdio. Used by `memento serve`.

## MCP resource and prompt

In addition to tools, the server exposes:

- **Resource `memento://context`** — returns ranked context as JSON (equivalent to calling `memory.context`).
- **Prompt `session-context`** — accepts an optional `focus` argument. Without `focus`, it calls `memory.context` for query-less ranked retrieval. With `focus`, it calls `memory.search` using the value as the query.
