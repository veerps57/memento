// Adapter tests for `buildMementoServer`.
//
// These exercise the projection from `CommandRegistry` onto
// MCP's tool surface end-to-end, going through a paired
// `InMemoryTransport` so the test traffic is real MCP
// JSON-RPC, not a fake. The point is to pin three properties:
//
//   1. **Surface filter.** Only commands whose `surfaces`
//      includes `'mcp'` are registered as tools. CLI-only
//      commands are silently dropped.
//   2. **Tool shape.** Each registered tool reports its
//      derived MCP name (`verb_noun` per ADR-0010), the
//      metadata description (with a deprecation note when
//      present), and a JSON Schema that round-trips the Zod
//      input schema.
//   3. **Result projection.** Successful command results
//      become text `content` with `isError: false`. Both
//      validation failures (`INVALID_INPUT` from
//      `executeCommand`) and handler-returned `Result.err`s
//      become `isError: true` results carrying the structured
//      `MementoError` on `_meta.error`. Unknown tools resolve
//      the same way.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type Command,
  type CommandContext,
  type CommandRegistry,
  createRegistry,
} from '@psraghuveer/memento-core';
import { err, ok } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildMementoServer } from '../src/build-server.js';

const ctx: CommandContext = { actor: { type: 'cli' } };

const echoCommand: Command<z.ZodObject<{ msg: z.ZodString }>, z.ZodObject<{ msg: z.ZodString }>> = {
  name: 'demo.echo',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({ msg: z.string().min(1) }).strict(),
  outputSchema: z.object({ msg: z.string() }).strict(),
  metadata: { description: 'Echo the input message back' },
  handler: async (input) => ok({ msg: input.msg }),
};

const failingCommand: Command<z.ZodObject<Record<string, never>>, z.ZodString> = {
  name: 'demo.fail',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.string(),
  metadata: { description: 'Always returns a structured error' },
  handler: async () =>
    err({
      code: 'NOT_FOUND',
      message: 'demo.fail: nothing here',
      details: { hint: 'this is intentional' },
    }),
};

const cliOnlyCommand: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
  name: 'demo.cliOnly',
  sideEffect: 'read',
  surfaces: ['cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.null(),
  metadata: { description: 'CLI-only command; must not appear over MCP' },
  handler: async () => ok(null),
};

const deprecatedCommand: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
  name: 'demo.legacy',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.null(),
  metadata: {
    description: 'Old command kept for compatibility',
    deprecated: 'use echo_demo',
  },
  handler: async () => ok(null),
};

const writeCommand: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
  name: 'demo.write',
  sideEffect: 'write',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.null(),
  metadata: {
    description: 'Write op (used to pin write-side annotation defaults)',
  },
  handler: async () => ok(null),
};

const destructiveCommand: Command<z.ZodObject<Record<string, never>>, z.ZodNull> = {
  name: 'demo.purge',
  sideEffect: 'destructive',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.null(),
  metadata: {
    description: 'Destructive op that opts in to idempotency + a display title',
    mcp: { idempotentHint: true, title: 'Purge (idempotent)' },
  },
  handler: async () => ok(null),
};

// Regression command for the `conflict.scan` shape: a top-
// level `z.discriminatedUnion` of object branches. `zodToJsonSchema`
// converts these to `{ anyOf: [...] }` *without* a top-level
// `type`, which the MCP SDK rejects at `tools/list`. The
// adapter's `normaliseToolInputSchema` is responsible for
// wrapping them as `{ type: 'object', oneOf: [...] }`. This
// command exists purely to pin that behaviour from a unit test
// — without it, only the cross-process E2E suite catches a
// regression and the failure mode is far less obvious.
const unionCommand: Command<
  z.ZodDiscriminatedUnion<
    'mode',
    [
      z.ZodObject<{ mode: z.ZodLiteral<'a'>; a: z.ZodString }>,
      z.ZodObject<{ mode: z.ZodLiteral<'b'>; b: z.ZodNumber }>,
    ]
  >,
  z.ZodNull
> = {
  name: 'demo.union',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('a'), a: z.string() }).strict(),
    z.object({ mode: z.literal('b'), b: z.number() }).strict(),
  ]),
  outputSchema: z.null(),
  metadata: { description: 'Top-level discriminated union input' },
  handler: async () => ok(null),
};

function buildTestRegistry(): CommandRegistry {
  return createRegistry()
    .register(echoCommand)
    .register(failingCommand)
    .register(cliOnlyCommand)
    .register(deprecatedCommand)
    .register(writeCommand)
    .register(destructiveCommand)
    .register(unionCommand)
    .freeze();
}

// Mock commands for resource and prompt handler tests.
const contextCommand: Command<z.ZodObject<Record<string, never>>, z.ZodAny> = {
  name: 'memory.context',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.any(),
  metadata: {
    description: 'Get memory context',
    mcpName: 'get_memory_context',
  },
  handler: async () =>
    ok({
      results: [
        {
          memory: { content: 'remember this', kind: { type: 'fact' }, tags: [] },
          score: 0.9,
        },
        {
          memory: { content: 'dark mode', kind: { type: 'preference' }, tags: ['ui'] },
          score: 0.7,
        },
      ],
    }),
};

const searchCommand: Command<z.ZodObject<{ text: z.ZodString }>, z.ZodAny> = {
  name: 'memory.search',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.object({ text: z.string() }).strict(),
  outputSchema: z.any(),
  metadata: {
    description: 'Search memories',
    mcpName: 'search_memory',
  },
  handler: async (input) => ok({ searched: true, query: `searched for: ${input.text}` }),
};

// Error-returning variants for testing error branches.
const failingContextCommand: Command<z.ZodObject<Record<string, never>>, z.ZodAny> = {
  name: 'memory.context',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.any(),
  metadata: {
    description: 'Get memory context (always fails)',
    mcpName: 'get_memory_context',
  },
  handler: async () => err({ code: 'STORAGE_ERROR', message: 'context: database is locked' }),
};

const failingSearchCommand: Command<z.ZodObject<{ text: z.ZodString }>, z.ZodAny> = {
  name: 'memory.search',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.object({ text: z.string() }).strict(),
  outputSchema: z.any(),
  metadata: {
    description: 'Search memories (always fails)',
    mcpName: 'search_memory',
  },
  handler: async () => err({ code: 'EMBEDDER_ERROR', message: 'search: embedder not loaded' }),
};

// Empty-results context command for testing the "no memories" branch.
const emptyContextCommand: Command<z.ZodObject<Record<string, never>>, z.ZodAny> = {
  name: 'memory.context',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.any(),
  metadata: {
    description: 'Get memory context (empty)',
    mcpName: 'get_memory_context',
  },
  handler: async () => ok({ results: [] }),
};

function buildRegistryWithContextAndSearch(): CommandRegistry {
  return createRegistry()
    .register(echoCommand)
    .register(contextCommand)
    .register(searchCommand)
    .freeze();
}

function buildRegistryWithFailingContext(): CommandRegistry {
  return createRegistry().register(echoCommand).register(failingContextCommand).freeze();
}

function buildRegistryWithFailingContextAndSearch(): CommandRegistry {
  return createRegistry()
    .register(echoCommand)
    .register(failingContextCommand)
    .register(failingSearchCommand)
    .freeze();
}

function buildRegistryWithEmptyContext(): CommandRegistry {
  return createRegistry().register(echoCommand).register(emptyContextCommand).freeze();
}

async function connect(registry: CommandRegistry): Promise<Client> {
  const server = buildMementoServer({ registry, ctx });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('buildMementoServer', () => {
  it('exposes only commands whose surfaces include "mcp"', async () => {
    const client = await connect(buildTestRegistry());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'echo_demo',
      'fail_demo',
      'legacy_demo',
      'purge_demo',
      'union_demo',
      'write_demo',
    ]);
    expect(names).not.toContain('cliOnly_demo');
    expect(names).not.toContain('demo.cliOnly');
  });

  it('reports each tool with description and a JSON-Schema input', async () => {
    const client = await connect(buildTestRegistry());
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === 'echo_demo');
    expect(echo).toBeDefined();
    expect(echo?.description).toBe('Echo the input message back');
    expect(echo?.inputSchema.type).toBe('object');
    // The Zod object had a single required `msg: string`.
    const schema = echo?.inputSchema as {
      type: string;
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    expect(schema.properties).toMatchObject({ msg: { type: 'string' } });
    expect(schema.required).toEqual(['msg']);
  });

  it('surfaces deprecation in the tool description', async () => {
    const client = await connect(buildTestRegistry());
    const { tools } = await client.listTools();
    const legacy = tools.find((t) => t.name === 'legacy_demo');
    expect(legacy?.description).toBe(
      'Old command kept for compatibility (deprecated: use echo_demo)',
    );
  });

  it('wraps a top-level discriminated-union input as an object schema with oneOf', async () => {
    // Regression for the `conflict.scan` shape:
    // `zodToJsonSchema` produces `{ anyOf: [...] }` for a
    // top-level `z.discriminatedUnion`, but MCP requires
    // `inputSchema.type === 'object'`. The adapter must wrap
    // the union under `oneOf` on an object schema. Without
    // that, `client.listTools()` itself throws (the SDK
    // validates every tool's inputSchema), which is exactly
    // what the cross-process E2E suite hits if this regresses.
    const client = await connect(buildTestRegistry());
    const { tools } = await client.listTools();
    const union = tools.find((t) => t.name === 'union_demo');
    expect(union).toBeDefined();
    expect(union?.inputSchema.type).toBe('object');
    const schema = union?.inputSchema as {
      type: string;
      anyOf?: readonly unknown[];
      oneOf?: readonly { type?: string }[];
    };
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeDefined();
    expect(schema.oneOf).toHaveLength(2);
    for (const branch of schema.oneOf ?? []) {
      expect(branch.type).toBe('object');
    }
  });

  it('round-trips a successful command result as text content', async () => {
    const client = await connect(buildTestRegistry());
    const result = await client.callTool({
      name: 'echo_demo',
      arguments: { msg: 'hello' },
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ msg: 'hello' }) }]);
  });

  it('projects validation failures onto isError with a structured MementoError', async () => {
    const client = await connect(buildTestRegistry());
    const result = await client.callTool({
      name: 'echo_demo',
      arguments: { msg: '' },
    });
    expect(result.isError).toBe(true);
    const meta = result._meta as { error: { code: string; message: string } } | undefined;
    expect(meta?.error.code).toBe('INVALID_INPUT');
    expect(meta?.error.message).toMatch(/demo\.echo/);
  });

  it('projects handler-returned err results onto isError', async () => {
    const client = await connect(buildTestRegistry());
    const result = await client.callTool({ name: 'fail_demo', arguments: {} });
    expect(result.isError).toBe(true);
    const meta = result._meta as
      | {
          error: { code: string; message: string; details?: { hint?: string } };
        }
      | undefined;
    expect(meta?.error.code).toBe('NOT_FOUND');
    expect(meta?.error.message).toBe('demo.fail: nothing here');
    expect(meta?.error.details?.hint).toBe('this is intentional');
  });

  it('returns isError for unknown tool names rather than a JSON-RPC error', async () => {
    const client = await connect(buildTestRegistry());
    const result = await client.callTool({ name: 'nope_demo', arguments: {} });
    expect(result.isError).toBe(true);
    const meta = result._meta as { error: { code: string; message: string } } | undefined;
    expect(meta?.error.code).toBe('INVALID_INPUT');
    expect(meta?.error.message).toMatch(/Unknown tool 'nope_demo'/);
  });

  it('refuses to expose a CLI-only command even when called by name', async () => {
    const client = await connect(buildTestRegistry());
    // The tool is filtered out at listTools, but a malicious / stale
    // client could still attempt to call it. The adapter must
    // refuse: the registry-level surface check is the only line
    // of defence between the registry and the wire.
    const result = await client.callTool({
      name: 'cliOnly_demo',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const meta = result._meta as { error: { code: string; message: string } } | undefined;
    expect(meta?.error.code).toBe('INVALID_INPUT');
    expect(meta?.error.message).toMatch(/Unknown tool 'cliOnly_demo'/);
  });

  it('honours custom server info on the initialize handshake', async () => {
    const registry = buildTestRegistry();
    const server = buildMementoServer({
      registry,
      ctx,
      info: { name: 'memento-test', version: '9.9.9' },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(client.getServerVersion()).toEqual({
      name: 'memento-test',
      version: '9.9.9',
    });
  });

  describe('resources', () => {
    it('ListResources returns the memento://context resource', async () => {
      const client = await connect(buildTestRegistry());
      const { resources } = await client.listResources();
      expect(resources).toHaveLength(1);
      expect(resources[0]).toEqual({
        uri: 'memento://context',
        name: 'Session Context',
        description:
          'The most relevant memories for the current session, ranked by confidence, recency, scope, and frequency.',
        mimeType: 'text/plain',
      });
    });

    it('ReadResource for memento://context returns formatted memory results', async () => {
      const registry = buildRegistryWithContextAndSearch();
      const client = await connect(registry);
      const result = await client.readResource({ uri: 'memento://context' });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]?.uri).toBe('memento://context');
      expect(result.contents[0]?.mimeType).toBe('text/plain');
      const entry = result.contents[0];
      const text = entry !== undefined && 'text' in entry ? (entry.text as string) : '';
      expect(text).toContain('Relevant memories (2)');
      expect(text).toContain('1. [fact] remember this');
      expect(text).toContain('2. [preference] [ui] dark mode');
    });

    it('ReadResource returns fallback when get_memory_context command is not registered', async () => {
      // buildTestRegistry() has no memory.context command.
      const client = await connect(buildTestRegistry());
      const result = await client.readResource({ uri: 'memento://context' });
      expect(result.contents).toHaveLength(1);
      const entry = result.contents[0];
      const text = entry !== undefined && 'text' in entry ? (entry.text as string) : '';
      expect(text).toBe('(memory.context command not available)');
    });

    it('ReadResource returns error text when context command returns an error', async () => {
      const client = await connect(buildRegistryWithFailingContext());
      const result = await client.readResource({ uri: 'memento://context' });
      expect(result.contents).toHaveLength(1);
      const entry = result.contents[0];
      const text = entry !== undefined && 'text' in entry ? (entry.text as string) : '';
      expect(text).toContain('Error loading context:');
      expect(text).toContain('database is locked');
    });

    it('ReadResource returns empty-store message when context has no results', async () => {
      const client = await connect(buildRegistryWithEmptyContext());
      const result = await client.readResource({ uri: 'memento://context' });
      expect(result.contents).toHaveLength(1);
      const entry = result.contents[0];
      const text = entry !== undefined && 'text' in entry ? (entry.text as string) : '';
      expect(text).toContain('No memories found');
    });

    it('ReadResource for an unknown URI throws an error', async () => {
      const client = await connect(buildTestRegistry());
      await expect(client.readResource({ uri: 'memento://unknown' })).rejects.toThrow(
        /Unknown resource/,
      );
    });
  });

  describe('prompts', () => {
    it('ListPrompts returns session-context prompt with focus argument', async () => {
      const client = await connect(buildTestRegistry());
      const { prompts } = await client.listPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.name).toBe('session-context');
      expect(prompts[0]?.description).toBe('Load relevant memories for this session');
      expect(prompts[0]?.arguments).toEqual([
        {
          name: 'focus',
          description:
            'Optional topic to focus on (triggers memory.search instead of memory.context)',
          required: false,
        },
      ]);
    });

    it('GetPrompt with no focus returns context results as messages', async () => {
      const registry = buildRegistryWithContextAndSearch();
      const client = await connect(registry);
      const result = await client.getPrompt({ name: 'session-context' });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.role).toBe('user');
      const text = (result.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toContain('Here are your relevant memories for this session');
      expect(text).toContain('- [fact] remember this');
      expect(text).toContain('- [preference] [ui] dark mode');
      expect(text).toContain('Call memory.confirm on any memory you actually use.');
    });

    it('GetPrompt with a focus argument uses search instead of context', async () => {
      const registry = buildRegistryWithContextAndSearch();
      const client = await connect(registry);
      const result = await client.getPrompt({
        name: 'session-context',
        arguments: { focus: 'dark mode' },
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.role).toBe('user');
      const text = (result.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toContain('Here are the relevant memories for "dark mode"');
      expect(text).toContain('searched for: dark mode');
    });

    it('GetPrompt with no focus returns fallback when get_memory_context is not registered', async () => {
      // buildTestRegistry() has no memory.context command.
      const client = await connect(buildTestRegistry());
      const result = await client.getPrompt({ name: 'session-context' });
      expect(result.messages).toHaveLength(1);
      const text = (result.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toBe('(memory.context not available)');
    });

    it('GetPrompt with no focus returns error when context command fails', async () => {
      const client = await connect(buildRegistryWithFailingContext());
      const result = await client.getPrompt({ name: 'session-context' });
      expect(result.messages).toHaveLength(1);
      const text = (result.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toContain('Error:');
      expect(text).toContain('database is locked');
    });

    it('GetPrompt with focus returns fallback when search_memory is not registered', async () => {
      // buildTestRegistry() has no memory.search command.
      const client = await connect(buildTestRegistry());
      const result = await client.getPrompt({
        name: 'session-context',
        arguments: { focus: 'dark mode' },
      });
      expect(result.messages).toHaveLength(1);
      const text = (result.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toBe('(memory.search not available)');
    });

    it('GetPrompt with focus returns error when search command fails', async () => {
      const client = await connect(buildRegistryWithFailingContextAndSearch());
      const result = await client.getPrompt({
        name: 'session-context',
        arguments: { focus: 'test query' },
      });
      expect(result.messages).toHaveLength(1);
      const text = (result.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toContain('Error:');
      expect(text).toContain('embedder not loaded');
    });

    it('GetPrompt with no focus returns empty-store message when context has no results', async () => {
      const client = await connect(buildRegistryWithEmptyContext());
      const result = await client.getPrompt({ name: 'session-context' });
      expect(result.messages).toHaveLength(1);
      const text = (result.messages[0]?.content as { type: string; text: string }).text;
      expect(text).toContain('No memories found yet');
    });

    it('GetPrompt for unknown prompt name throws an error', async () => {
      const client = await connect(buildTestRegistry());
      await expect(client.getPrompt({ name: 'unknown-prompt' })).rejects.toThrow(/Unknown prompt/);
    });
  });

  describe('tool annotations', () => {
    it('derives readOnlyHint:true and openWorldHint:false for read commands', async () => {
      const client = await connect(buildTestRegistry());
      const { tools } = await client.listTools();
      const echo = tools.find((t) => t.name === 'echo_demo');
      expect(echo?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    });

    it('derives readOnlyHint:false and destructiveHint:false for write commands', async () => {
      const client = await connect(buildTestRegistry());
      const { tools } = await client.listTools();
      const writeT = tools.find((t) => t.name === 'write_demo');
      expect(writeT?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    });

    it('honours per-command idempotentHint and title overrides', async () => {
      const client = await connect(buildTestRegistry());
      const { tools } = await client.listTools();
      const purge = tools.find((t) => t.name === 'purge_demo');
      expect(purge?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        title: 'Purge (idempotent)',
      });
    });
  });
});
