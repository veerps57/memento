// ADR 0003 contract test — adapter parity.
//
// The command registry is the source of truth for which surface
// each command lives on. Both adapters (`@psraghuveer/memento-server` for
// MCP, `@psraghuveer/memento-cli` for CLI) project the registry through a
// surface filter. The promise this test pins:
//
//   For every registered command,
//     command.surfaces == { adapters that expose it }
//
// In practice that means:
//
//   - a command tagged `['mcp', 'cli']` shows up in both
//     `client.listTools()` and `adapter.names`;
//   - a `['cli']`-only command shows up in the CLI adapter and
//     NOT in the MCP tool list;
//   - a `['mcp']`-only command shows up in the MCP tool list
//     and NOT in the CLI adapter.
//
// (The registry rejects `surfaces: []` at registration time —
// a command nobody can call is dead code — so that row of the
// matrix does not exist here. It is pinned by the registry's
// own tests.)
//
// Drift in either adapter — a forgotten surface check, a typo
// of the surface marker, an accidental allow-list — fails this
// test. A future HTTP/SSE adapter (v2) will be added to the
// matrix below the same way; the test is the contract slot ADR
// 0003 promised.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type AnyCommand,
  type CommandContext,
  createRegistry,
  deriveMcpName,
} from '@psraghuveer/memento-core';
import { buildMementoServer } from '@psraghuveer/memento-server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildCliAdapter } from '../src/build-adapter.js';

const ctx: CommandContext = { actor: { type: 'cli' } };

// Each fixture command pins one row of the parity matrix. The
// test below iterates `command.surfaces` and asserts both sides.
const bothCommand = {
  name: 'parity.both',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.literal('ok'),
  metadata: { description: 'Exposed on both surfaces' },
  handler: async () => ({ ok: true as const, value: 'ok' as const }),
} as const;

const cliOnlyCommand = {
  name: 'parity.cliOnly',
  sideEffect: 'read',
  surfaces: ['cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.literal('ok'),
  metadata: { description: 'CLI-only command' },
  handler: async () => ({ ok: true as const, value: 'ok' as const }),
} as const;

const mcpOnlyCommand = {
  name: 'parity.mcpOnly',
  sideEffect: 'read',
  surfaces: ['mcp'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.literal('ok'),
  metadata: { description: 'MCP-only command' },
  handler: async () => ({ ok: true as const, value: 'ok' as const }),
} as const;

const fixtureRegistry = () =>
  createRegistry().register(bothCommand).register(cliOnlyCommand).register(mcpOnlyCommand).freeze();

async function listMcpToolNames(): Promise<readonly string[]> {
  const server = buildMementoServer({ registry: fixtureRegistry(), ctx });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'parity-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

function listCliCommandNames(): readonly string[] {
  return buildCliAdapter({ registry: fixtureRegistry(), ctx }).names;
}

describe('adapter parity (ADR 0003)', () => {
  it('every command appears on exactly the surfaces it declares', async () => {
    const registry = fixtureRegistry();
    const mcpNames = new Set(await listMcpToolNames());
    const cliNames = new Set(listCliCommandNames());

    for (const command of registry.list()) {
      const declared = new Set<string>(command.surfaces);
      const observed = new Set<string>();
      if (mcpNames.has(deriveMcpName(command))) observed.add('mcp');
      if (cliNames.has(command.name)) observed.add('cli');
      expect({ name: command.name, surfaces: [...observed].sort() }).toEqual({
        name: command.name,
        surfaces: [...declared].sort(),
      });
    }
  });

  it('the union of adapter projections equals every registered command', async () => {
    const registry = fixtureRegistry();
    const mcpNames = new Set(await listMcpToolNames());
    const cliNames = new Set(listCliCommandNames());

    const exposed = new Set<string>([...cliNames]);
    for (const command of registry.list()) {
      if (mcpNames.has(deriveMcpName(command))) exposed.add(command.name);
    }
    const expected = new Set(registry.list().map((cmd: AnyCommand) => cmd.name));
    expect([...exposed].sort()).toEqual([...expected].sort());
  });
});
