// Lifecycle test for `connectUntilClose`.
//
// The full stdio byte path is exercised by the SDK's own tests;
// here we only pin the small piece `@psraghuveer/memento-server` adds —
// connect a server to a transport and resolve when the
// transport's `close()` runs, while still chaining whatever
// `onclose` the SDK installed first.

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CommandContext, createRegistry } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildMementoServer } from '../src/build-server.js';
import { connectUntilClose } from '../src/serve-stdio.js';

const ctx: CommandContext = { actor: { type: 'cli' } };

const noopRegistry = () =>
  createRegistry()
    .register({
      name: 'demo.ping',
      sideEffect: 'read',
      surfaces: ['mcp', 'cli'],
      inputSchema: z.object({}).strict(),
      outputSchema: z.literal('pong'),
      metadata: { description: 'Ping' },
      handler: async () => ({ ok: true as const, value: 'pong' as const }),
    })
    .freeze();

describe('connectUntilClose', () => {
  it('resolves when the transport closes', async () => {
    const server = buildMementoServer({ registry: noopRegistry(), ctx });
    const [, serverTransport] = InMemoryTransport.createLinkedPair();

    const done = connectUntilClose(server, serverTransport);
    // Defer to the next microtask so the connect chain settles
    // before we close. close() is what should resolve `done`.
    await new Promise((r) => setImmediate(r));
    await serverTransport.close();
    await expect(done).resolves.toBeUndefined();
  });
});
