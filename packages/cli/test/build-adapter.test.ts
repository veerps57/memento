// Unit tests for `buildCliAdapter`.
//
// These mirror the shape of `@psraghuveer/memento-server`'s adapter tests:
// they pin the surface filter, the success path, and the three
// failure paths (validation rejection, handler error, unknown
// command). The cross-adapter exposure rule lives separately in
// `./parity.contract.test.ts`.

import { type CommandContext, createRegistry } from '@psraghuveer/memento-core';
import { err } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildCliAdapter } from '../src/build-adapter.js';

const ctx: CommandContext = { actor: { type: 'cli' } };

const echoCommand = {
  name: 'demo.echo',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({ msg: z.string().min(1) }).strict(),
  outputSchema: z.object({ msg: z.string() }).strict(),
  metadata: { description: 'Echo a message' },
  handler: async ({ msg }: { msg: string }) => ({
    ok: true as const,
    value: { msg },
  }),
} as const;

const failingCommand = {
  name: 'demo.fail',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.unknown(),
  metadata: { description: 'Always fails' },
  handler: async () =>
    err({
      code: 'NOT_FOUND' as const,
      message: 'demo.fail: nothing here',
      details: { hint: 'this is intentional' },
    }),
} as const;

const mcpOnlyCommand = {
  name: 'demo.mcpOnly',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.literal('ok'),
  metadata: { description: 'mcp-only command' },
  handler: async () => ({ ok: true as const, value: 'ok' as const }),
} as const;

const fixtureRegistry = () =>
  createRegistry().register(echoCommand).register(failingCommand).register(mcpOnlyCommand).freeze();

describe('buildCliAdapter', () => {
  it('exposes only commands whose surfaces include "cli"', () => {
    const adapter = buildCliAdapter({ registry: fixtureRegistry(), ctx });
    expect(adapter.names).toEqual(['demo.echo', 'demo.fail']);
  });

  it('runs a command and returns the validated output as Result.ok', async () => {
    const adapter = buildCliAdapter({ registry: fixtureRegistry(), ctx });
    const result = await adapter.run('demo.echo', { msg: 'hello' });
    expect(result).toEqual({ ok: true, value: { msg: 'hello' } });
  });

  it('returns INVALID_INPUT when the raw input fails the schema', async () => {
    const adapter = buildCliAdapter({ registry: fixtureRegistry(), ctx });
    const result = await adapter.run('demo.echo', { msg: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/demo\.echo/);
  });

  it('passes handler-returned err results through unchanged', async () => {
    const adapter = buildCliAdapter({ registry: fixtureRegistry(), ctx });
    const result = await adapter.run('demo.fail', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: 'NOT_FOUND',
      message: 'demo.fail: nothing here',
      details: { hint: 'this is intentional' },
    });
  });

  it('refuses commands that exist on the registry but not on the cli surface', async () => {
    const adapter = buildCliAdapter({ registry: fixtureRegistry(), ctx });
    const result = await adapter.run('demo.mcpOnly', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/Unknown command 'demo\.mcpOnly'/);
  });

  it('returns INVALID_INPUT for an entirely unknown command name', async () => {
    const adapter = buildCliAdapter({ registry: fixtureRegistry(), ctx });
    const result = await adapter.run('demo.nope', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/Unknown command 'demo\.nope'/);
  });
});
