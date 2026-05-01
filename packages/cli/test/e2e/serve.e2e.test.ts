import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMementoApp } from '@psraghuveer/memento-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// `packages/cli/test/e2e/serve.e2e.test.ts` -> `packages/cli/dist/cli.js`
const CLI_PATH = resolve(HERE, '..', '..', 'dist', 'cli.js');

/**
 * Pull the JSON value out of an MCP tool result. The Memento
 * adapter encodes successful command output as a single
 * `{ type: 'text', text: <JSON> }` block carrying the command's
 * output value directly (see
 * `packages/server/src/build-server.ts#successResult`). On
 * failure, the same shape carries `<code>: <message>` and the
 * structured error lands in `_meta.error`.
 */
function parseToolJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  expect(result.isError ?? false, `tool returned isError; content: ${JSON.stringify(result)}`).toBe(
    false,
  );
  // The MCP SDK's `callTool` return type unions both the
  // current `{ content: [...] }` shape and a legacy
  // `{ toolResult: unknown }` shape. Memento always returns
  // the modern shape via `successResult`/`errorResult`, so we
  // narrow with a runtime check before indexing.
  const content = (result as CallToolResult).content;
  expect(Array.isArray(content), 'tool result missing content array').toBe(true);
  const block = content[0];
  expect(block?.type).toBe('text');
  const text = (block as { text: string }).text;
  return JSON.parse(text);
}

interface MemoryRecord {
  id: string;
  content: string;
}

interface SearchResult {
  results: { memory: MemoryRecord }[];
}

describe('memento serve (MCP stdio end-to-end)', () => {
  beforeAll(() => {
    // Fail fast with a useful message if someone ran the e2e
    // suite without building first. `pnpm test:e2e` chains the
    // build, so the only way to hit this is to invoke vitest
    // directly with the e2e config.
    expect(
      existsSync(CLI_PATH),
      `Expected built CLI at ${CLI_PATH}. Run \`pnpm build\` (or \`pnpm test:e2e\`) first.`,
    ).toBe(true);
  });

  let dbDir: string;
  let dbPath: string;
  let client: Client | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close().catch(() => {
        // Best-effort: if the server already exited (e.g. the
        // test failed mid-call), close() may throw. Not worth
        // surfacing — the assertion that already failed is the
        // useful signal.
      });
      client = undefined;
    }
    if (dbDir !== undefined && existsSync(dbDir)) {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('lists tools and round-trips write_memory -> search_memory -> read_memory', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'memento-e2e-'));
    dbPath = join(dbDir, 'memento.db');

    // Pre-seed the DB with `retrieval.vector.enabled=false` so
    // the CLI's `openAppForSurface` skips the embedder resolution
    // path. Without this, the default `true` triggers a lazy model
    // download (~30MB from HuggingFace Hub) on the first embed()
    // call, making the e2e test slow and network-dependent. Vector
    // retrieval is covered by unit tests; this test exercises the
    // MCP round-trip over FTS.
    const seed = await createMementoApp({ dbPath });
    await seed.configRepository.set(
      { key: 'retrieval.vector.enabled', value: false, source: 'cli' },
      { actor: { type: 'cli' } },
    );
    seed.close();

    // StdioClientTransport spawns and owns the child. We do
    // not pass `cwd` or `env` — the CLI must work with an
    // unrestricted environment, which is what every real MCP
    // client gives it.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, '--db', dbPath, 'serve'],
    });

    client = new Client({ name: 'memento-e2e', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // 1. Tool discovery. The exact tool count is not asserted
    //    (it grows when commands are added) — what matters is
    //    that the registry got projected and the three tools
    //    we exercise below are present.
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((t) => t.name));
    for (const required of ['write_memory', 'search_memory', 'read_memory']) {
      expect(toolNames, `MCP tool '${required}' missing from tools/list`).toContain(required);
    }

    // 2. Write a memory with a marker phrase that's unlikely
    //    to collide with anything else under FTS. The shape
    //    mirrors `MemoryWriteInputSchema`.
    const marker = `e2e-marker-${Date.now()}`;
    const writeResult = await client.callTool({
      name: 'write_memory',
      arguments: {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: ['e2e'],
        pinned: false,
        content: `Smoke test wrote this memory. ${marker}.`,
        summary: null,
        storedConfidence: 0.9,
      },
    });
    const writeEnvelope = parseToolJson(writeResult) as MemoryRecord;
    // Memory IDs are 26-character Crockford-base32 ULIDs; the
    // schema enforces this via `MemoryIdSchema` and we re-check
    // the format here so a regression that returns an empty or
    // truncated id is caught before the search/read calls
    // dereference it.
    expect(writeEnvelope.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const writtenId = writeEnvelope.id;

    // 3. Search for the marker. The marker is unique enough
    //    that exactly one result is the right number; if FTS
    //    decides to return more later (e.g. tag-based hits),
    //    the assertion stays correct as long as our id is in
    //    the set.
    const searchResult = await client.callTool({
      name: 'search_memory',
      arguments: { text: marker },
    });
    const searchEnvelope = parseToolJson(searchResult) as SearchResult;
    const searchIds = (searchEnvelope.results ?? []).map((r) => r.memory.id);
    expect(searchIds, `marker '${marker}' not found via search_memory`).toContain(writtenId);

    // 4. Read back the memory. This proves the write was
    //    persisted to the SQLite file (the search result
    //    already proves FTS sees it; this proves the row is
    //    in the canonical table too).
    const readResult = await client.callTool({
      name: 'read_memory',
      arguments: { id: writtenId },
    });
    const readEnvelope = parseToolJson(readResult) as MemoryRecord | null;
    expect(readEnvelope?.id).toBe(writtenId);
    expect(readEnvelope?.content).toContain(marker);
  });
});
