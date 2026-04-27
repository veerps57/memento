// Stdio entry point for the MCP adapter.
//
// `buildMementoServer` is transport-agnostic by design; this
// file is the only place in `@psraghuveer/memento-server` that knows about
// stdio. v1 ships stdio only — every supported MCP client (the
// AI assistants in the README) drives the server as a child
// process over stdio, and `KNOWN_LIMITATIONS.md` defers HTTP /
// SSE to v2. When that lands it will be a sibling of this
// file, not a replacement.
//
// `serveStdio` is a small lifecycle helper: it builds the
// server, attaches a `StdioServerTransport`, and resolves once
// the transport is closed (either side disconnects). Hosts
// (`npx memento serve`, tests, embeddings) own the registry
// and `CommandContext`; this file owns the transport.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type BuildMementoServerOptions, buildMementoServer } from './build-server.js';

/**
 * Connect a server to a transport and return a promise that
 * resolves when the transport closes. Factored out of
 * `serveStdio` so it can be tested with an `InMemoryTransport`
 * — the close-handler chaining is the only non-trivial bit and
 * the SDK's own tests cover the stdio byte transport.
 */
export async function connectUntilClose(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const previous = transport.onclose;
    transport.onclose = (): void => {
      previous?.();
      resolve();
    };
  });
}

/**
 * Connect a Memento MCP server to stdio.
 *
 * Returns a promise that resolves when the transport closes —
 * normally because the parent process terminated the child or
 * the JSON-RPC peer sent a `close`. Hosts that need to shut
 * down the server proactively can call `.close()` on a
 * transport they own; for that flow, prefer `buildMementoServer`
 * directly and manage the transport yourself.
 */
export async function serveStdio(options: BuildMementoServerOptions): Promise<void> {
  const server = buildMementoServer(options);
  const transport = new StdioServerTransport();
  await connectUntilClose(server, transport);
}
