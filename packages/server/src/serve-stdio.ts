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
//
// Bounded read buffer. The MCP SDK's `StdioServerTransport`
// performs naive `Buffer.concat` on every chunk it receives
// from `process.stdin` and only flushes complete JSON-RPC
// lines (terminated by `\n`). Without a cap, a peer that
// withholds the trailing newline can grow the buffer until
// Node OOMs. `serveStdio` therefore wraps the inbound stream
// in a `BoundedReadable` that destroys the stream once any
// run of bytes between newlines exceeds `maxMessageBytes`. The
// SDK sees the destroy as a transport error and shuts down
// cleanly; the next-launched MCP server starts fresh.

import process from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { Transform } from 'node:stream';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type BuildMementoServerOptions, buildMementoServer } from './build-server.js';

const NEWLINE = 0x0a;

/**
 * Default cap when a host does not pass `maxMessageBytes`. 4 MiB
 * is large enough for any real MCP payload (the protocol itself
 * has no soft limit, but every observed MCP message in practice
 * is well under 1 MiB) and small enough that a runaway peer
 * cannot push the process into the OOM-killer's reach.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/**
 * Wrap a Readable byte stream so that any contiguous run of
 * bytes between newlines exceeding `maxBytes` destroys the
 * stream with a typed error. Pass-through otherwise.
 *
 * Tracking is per "unflushed run" — the bytes since the last
 * `\n` we observed. A single chunk can contain multiple newlines;
 * we scan for the *last* one and reset the unflushed counter
 * accordingly.
 */
export function createBoundedStdin(stdin: Readable, maxBytes: number): Readable {
  let unflushed = 0;
  const wrapper = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      let lastNewline = -1;
      for (let i = chunk.length - 1; i >= 0; i -= 1) {
        if (chunk[i] === NEWLINE) {
          lastNewline = i;
          break;
        }
      }
      if (lastNewline >= 0) {
        unflushed = chunk.length - 1 - lastNewline;
      } else {
        unflushed += chunk.length;
      }
      if (unflushed > maxBytes) {
        cb(
          new Error(
            `MCP stdio: incoming JSON-RPC message exceeds maxMessageBytes (${maxBytes}). The transport is closing the stream.`,
          ),
        );
        return;
      }
      cb(null, chunk);
    },
  });
  // Forward errors from the source so the SDK sees them through
  // the wrapper. Unpipe on error so the source does not keep
  // pushing into a destroyed Transform.
  stdin.on('error', (err) => {
    wrapper.destroy(err);
  });
  stdin.pipe(wrapper);
  return wrapper;
}

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

export interface ServeStdioTransportOptions {
  /**
   * Hard upper bound on a single JSON-RPC message read from
   * stdin, in bytes. Defaults to {@link DEFAULT_MAX_MESSAGE_BYTES}.
   */
  readonly maxMessageBytes?: number;
  /**
   * Inbound byte stream. Defaults to `process.stdin`. Override
   * for tests that drive the transport with a `PassThrough`.
   */
  readonly stdin?: Readable;
  /**
   * Outbound byte stream. Defaults to `process.stdout`.
   */
  readonly stdout?: Writable;
}

export type ServeStdioOptions = BuildMementoServerOptions & {
  readonly transport?: ServeStdioTransportOptions;
};

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
export async function serveStdio(options: ServeStdioOptions): Promise<void> {
  const server = buildMementoServer(options);
  const maxBytes = options.transport?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const stdin = options.transport?.stdin ?? process.stdin;
  const stdout = options.transport?.stdout ?? process.stdout;
  const bounded = createBoundedStdin(stdin, maxBytes);
  const transport = new StdioServerTransport(bounded, stdout);
  await connectUntilClose(server, transport);
}
