// Lifecycle test for `connectUntilClose`.
//
// The full stdio byte path is exercised by the SDK's own tests;
// here we only pin the small piece `@psraghuveer/memento-server` adds —
// connect a server to a transport and resolve when the
// transport's `close()` runs, while still chaining whatever
// `onclose` the SDK installed first.

import { PassThrough } from 'node:stream';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CommandContext, createRegistry } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildMementoServer } from '../src/build-server.js';
import { connectUntilClose, createBoundedStdin } from '../src/serve-stdio.js';

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

describe('createBoundedStdin', () => {
  // A peer that withholds the trailing newline must not be
  // able to grow the read buffer past the cap. The wrapper
  // destroys the stream with a typed error; the SDK sees that
  // as a transport error and shuts down.
  it('passes through traffic under the cap', async () => {
    const source = new PassThrough();
    const bounded = createBoundedStdin(source, 1024);
    const chunks: Buffer[] = [];
    bounded.on('data', (c: Buffer) => chunks.push(c));
    const closed = new Promise<void>((resolve) => bounded.on('end', resolve));
    source.write('{"a":1}\n{"b":2}\n');
    source.end();
    await closed;
    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('destroys the stream when an unflushed run exceeds the cap', async () => {
    const source = new PassThrough();
    const bounded = createBoundedStdin(source, 16);
    const error = await new Promise<Error>((resolve) => {
      bounded.on('error', resolve);
      bounded.on('data', () => {
        /* drain */
      });
      // Write a run > 16 bytes with no newline.
      source.write('a'.repeat(64));
    });
    expect(error.message).toMatch(/exceeds maxMessageBytes/u);
  });

  it('resets the unflushed counter at every newline', async () => {
    const source = new PassThrough();
    const bounded = createBoundedStdin(source, 16);
    const chunks: Buffer[] = [];
    bounded.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((resolve) => bounded.on('end', resolve));
    // 12 bytes, newline, 12 bytes — never more than 12 unflushed.
    source.write('aaaaaaaaaaaa\nbbbbbbbbbbbb\n');
    source.end();
    await ended;
    expect(Buffer.concat(chunks).toString('utf8')).toBe('aaaaaaaaaaaa\nbbbbbbbbbbbb\n');
  });
});
