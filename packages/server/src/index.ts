// @psraghuveer/memento-server — the MCP adapter.
//
// Translates `@modelcontextprotocol/sdk` tool calls into
// invocations against the `@psraghuveer/memento-core` command registry.
// Owns the stdio transport. Stays thin on purpose: the parity
// guarantee with the CLI adapter is structural (ADR 0003), so
// anything beyond MCP-protocol concerns belongs in
// `@psraghuveer/memento-core`, not here.

export {
  buildMementoServer,
  type BuildMementoServerOptions,
  type ServerInfo,
} from './build-server.js';
export { serveStdio } from './serve-stdio.js';
