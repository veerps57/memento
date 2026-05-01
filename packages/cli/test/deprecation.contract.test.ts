// ADR-0015 contract test — registry command deprecation policy.
//
// Pins, as a contract: a command marked
// `metadata.deprecated = "<...>"` keeps every commitment the
// policy makes:
//
//   1. It remains resolvable on every surface it declared. No
//      surface filter narrows it.
//   2. The MCP `tools/list` description carries the
//      `(deprecated: <rationale>)` suffix so a client's tool
//      picker shows the deprecation in the same row it shows
//      the tool.
//   3. The CLI reference renderer (the source of
//      `docs/reference/cli.md`) emits a `**Deprecated:**` bullet
//      under the command entry.
//   4. The MCP tools renderer (the source of
//      `docs/reference/mcp-tools.md`) emits a `**Deprecated:**`
//      bullet under the tool entry.
//
// A fixture deprecated command exercises every check; the loop
// at the bottom also re-asserts checks (3) and (4) for any real
// command in the production registry that grows the flag in
// the future.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type AnyCommand,
  type CommandContext,
  createMementoApp,
  createRegistry,
  deriveMcpName,
  renderCliDoc,
  renderMcpToolsDoc,
} from '@psraghuveer/memento-core';
import { buildMementoServer } from '@psraghuveer/memento-server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildCliAdapter } from '../src/build-adapter.js';

const ctx: CommandContext = { actor: { type: 'cli' } };

const DEPRECATION_NOTE = 'use parity.replacement instead; removed in v2.0.0';

const deprecatedBoth = {
  name: 'parity.deprecatedBoth',
  sideEffect: 'read',
  surfaces: ['mcp', 'cli'],
  inputSchema: z.object({}).strict(),
  outputSchema: z.literal('ok'),
  metadata: {
    description: 'Deprecated command exposed on both surfaces',
    deprecated: DEPRECATION_NOTE,
  },
  handler: async () => ({ ok: true as const, value: 'ok' as const }),
} as const;

const fixtureRegistry = () => createRegistry().register(deprecatedBoth).freeze();

async function listMcpTools() {
  const server = buildMementoServer({ registry: fixtureRegistry(), ctx });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'deprecation-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

describe('deprecation policy (ADR-0015)', () => {
  it('a deprecated command is still resolvable on every surface it declares', async () => {
    const registry = fixtureRegistry();
    const tools = await listMcpTools();
    const cli = buildCliAdapter({ registry, ctx });

    const cmd = registry.list().find((c: AnyCommand) => c.name === 'parity.deprecatedBoth');
    expect(cmd).toBeDefined();
    if (cmd === undefined) return;

    // MCP — the tool name (snake_case verb_noun) is present.
    const mcpName = deriveMcpName(cmd);
    expect(tools.some((t) => t.name === mcpName)).toBe(true);

    // CLI — the dotted name is present.
    expect(cli.names).toContain('parity.deprecatedBoth');

    // Calling it works (no behaviour change vs. non-deprecated).
    const result = await cli.run('parity.deprecatedBoth', {});
    expect(result.ok).toBe(true);
  });

  it('the MCP tool description carries the (deprecated: …) suffix', async () => {
    const tools = await listMcpTools();
    const tool = tools.find((t) => t.name === deriveMcpName(deprecatedBoth));
    expect(tool).toBeDefined();
    expect(tool?.description).toBe(
      `Deprecated command exposed on both surfaces (deprecated: ${DEPRECATION_NOTE})`,
    );
  });

  it('the CLI reference renderer emits a **Deprecated:** bullet for the command', () => {
    const doc = renderCliDoc([deprecatedBoth]);
    expect(doc).toContain('### `memento parity deprecatedBoth`');
    expect(doc).toContain(`- **Deprecated:** ${DEPRECATION_NOTE}`);
  });

  it('the MCP tools renderer emits a **Deprecated:** bullet for the tool', () => {
    const doc = renderMcpToolsDoc([deprecatedBoth]);
    expect(doc).toContain(`- **Deprecated:** ${DEPRECATION_NOTE}`);
  });

  it('every real command in the production registry that carries `deprecated` complies with the policy', async () => {
    // Catches future drift: the moment a real command grows
    // `metadata.deprecated`, this loop adds it to the contract
    // surface without anyone editing this test.
    const app = await createMementoApp({ dbPath: ':memory:' });
    const deprecated = app.registry
      .list()
      .filter((c: AnyCommand) => c.metadata.deprecated !== undefined);
    if (deprecated.length === 0) {
      // No real deprecated commands in v1; the fixture above
      // carries the contract for now.
      return;
    }

    const cliDoc = renderCliDoc(deprecated);
    const mcpDoc = renderMcpToolsDoc(deprecated);
    for (const cmd of deprecated) {
      const note = cmd.metadata.deprecated;
      expect(cmd.surfaces.length, `${cmd.name} must keep at least one surface`).toBeGreaterThan(0);
      if (cmd.surfaces.includes('cli')) {
        expect(cliDoc).toContain(`- **Deprecated:** ${note}`);
      }
      if (cmd.surfaces.includes('mcp')) {
        expect(mcpDoc).toContain(`- **Deprecated:** ${note}`);
      }
    }
  });
});
