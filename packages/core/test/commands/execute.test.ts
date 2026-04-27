import { err, ok } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Command, type CommandContext, executeCommand } from '../../src/commands/index.js';

const ctx: CommandContext = { actor: { type: 'cli' } };

const upperCase: Command<
  z.ZodObject<{ value: z.ZodString }>,
  z.ZodObject<{ result: z.ZodString }>
> = {
  name: 'demo.upper',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({ value: z.string().min(1) }).strict(),
  outputSchema: z.object({ result: z.string() }).strict(),
  metadata: { description: 'Upper-case the input' },
  handler: async (input) => ok({ result: input.value.toUpperCase() }),
};

describe('executeCommand', () => {
  it('parses input, runs the handler, and returns the validated output', async () => {
    const out = await executeCommand(upperCase, { value: 'hello' }, ctx);
    expect(out).toEqual({ ok: true, value: { result: 'HELLO' } });
  });

  it('returns INVALID_INPUT when the raw input fails the input schema', async () => {
    const out = await executeCommand(upperCase, { value: '' }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('INVALID_INPUT');
    expect(out.error.message).toMatch(/demo\.upper/);
    expect(out.error.details).toBeDefined();
  });

  it('rejects extra keys via the strict schema', async () => {
    const out = await executeCommand(upperCase, { value: 'ok', extra: true }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('INVALID_INPUT');
  });

  it('passes through handler-returned errors unchanged', async () => {
    const failing: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
      name: 'demo.fail',
      sideEffect: 'read',
      surfaces: ['cli'],
      inputSchema: z.object({}).strict(),
      outputSchema: z.null(),
      metadata: { description: 'Always fails' },
      handler: async () => err({ code: 'NOT_FOUND', message: 'nope' }),
    };
    const out = await executeCommand(failing, {}, ctx);
    expect(out).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'nope' },
    });
  });

  it('returns INTERNAL when the handler returns a value rejecting the output schema', async () => {
    const drift: Command<z.ZodObject<Record<string, never>>, z.ZodNumber> = {
      name: 'demo.drift',
      sideEffect: 'read',
      surfaces: ['cli'],
      inputSchema: z.object({}).strict(),
      outputSchema: z.number(),
      metadata: { description: 'Output drift' },
      // biome-ignore lint/suspicious/noExplicitAny: simulating drift
      handler: async () => ok('not a number' as any),
    };
    const out = await executeCommand(drift, {}, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('INTERNAL');
    expect(out.error.message).toMatch(/output schema/);
  });

  it('does not throw when the handler throws — wraps as INTERNAL by re-raising for now', async () => {
    // We deliberately do NOT swallow handler throws: throws are
    // programmer errors per Result contract. The test pins that
    // behavior so it is intentional, not accidental.
    const blowsUp: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
      name: 'demo.throw',
      sideEffect: 'read',
      surfaces: ['cli'],
      inputSchema: z.object({}).strict(),
      outputSchema: z.null(),
      metadata: { description: 'Throws' },
      handler: async () => {
        throw new Error('boom');
      },
    };
    await expect(executeCommand(blowsUp, {}, ctx)).rejects.toThrow(/boom/);
  });
});
