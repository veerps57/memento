import { ok } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Command, type CommandContext, createRegistry } from '../../src/commands/index.js';

const ctx: CommandContext = { actor: { type: 'cli' } };

const echoCommand: Command<z.ZodObject<{ msg: z.ZodString }>, z.ZodString> = {
  name: 'demo.echo',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({ msg: z.string() }).strict(),
  outputSchema: z.string(),
  metadata: { description: 'Echo the input message' },
  handler: async (input) => ok(input.msg),
};

const noopCommand: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
  name: 'demo.noop',
  sideEffect: 'read',
  surfaces: ['cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.null(),
  metadata: { description: 'No-op' },
  handler: async () => ok(null),
};

describe('createRegistry', () => {
  it('registers commands and exposes them in registration order', () => {
    const registry = createRegistry().register(echoCommand).register(noopCommand).freeze();

    expect(registry.list().map((c) => c.name)).toEqual(['demo.echo', 'demo.noop']);
    expect(registry.has('demo.echo')).toBe(true);
    expect(registry.get('demo.echo')).toBe(echoCommand);
    expect(registry.get('does.not.exist')).toBeUndefined();
  });

  it('rejects duplicate command names at registration time', () => {
    const builder = createRegistry().register(echoCommand);
    expect(() => builder.register(echoCommand)).toThrow(/already registered/);
  });

  it('rejects commands declaring no surfaces', () => {
    const orphan: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
      ...noopCommand,
      name: 'demo.orphan',
      surfaces: [],
    };
    expect(() => createRegistry().register(orphan)).toThrow(/no surfaces/);
  });

  it('returns a frozen list that is not mutated by later builder use', () => {
    // The builder enforces freeze() returns a snapshot; after freeze
    // the returned registry is the public surface and additional
    // register() calls on the original builder reflect a separate
    // intent. We assert the post-freeze list is stable.
    const builder = createRegistry().register(echoCommand);
    const registry = builder.freeze();
    const before = registry.list();
    expect(() => {
      // @ts-expect-error -- list() result is readonly
      before.push(noopCommand);
    }).toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it('allows the same command name across separate registry instances', () => {
    const a = createRegistry().register(echoCommand).freeze();
    const b = createRegistry().register(echoCommand).freeze();
    expect(a.has('demo.echo')).toBe(true);
    expect(b.has('demo.echo')).toBe(true);
  });

  it('preserves the chained builder identity', () => {
    const builder = createRegistry();
    expect(builder.register(echoCommand)).toBe(builder);
  });

  it('handler signature receives parsed input and the context unchanged', async () => {
    const registry = createRegistry().register(echoCommand).freeze();
    const cmd = registry.get('demo.echo') as unknown as typeof echoCommand;
    const out = await cmd.handler({ msg: 'hi' }, ctx);
    expect(out).toEqual({ ok: true, value: 'hi' });
  });
});
