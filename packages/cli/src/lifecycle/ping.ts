// `memento ping` — round-trip an MCP `tools/list` against a
// child `serve` process to prove the transport works.
//
// Why this matters: `memento doctor` proves the host is healthy,
// `memento init` produces a paste-able snippet — but neither
// answers "would my AI assistant be able to talk to memento right
// now?" without actually starting the assistant. `ping` closes
// that gap by acting as the assistant: it spawns
// `memento serve` over stdio, sends a `tools/list` JSON-RPC
// request, and returns the tool count.
//
// Implementation notes
// --------------------
//
// We deliberately avoid pulling in the MCP client SDK. The wire
// format for stdio MCP is well-known JSON-RPC 2.0 with newline
// framing; one initialise + one tools/list is enough to prove
// liveness, and rolling them by hand keeps `ping` light enough to
// run in CI without dragging another peer dep into the CLI.

import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveVersion } from '../version.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Stable contract for `memento ping`. */
export interface PingSnapshot {
  readonly version: string;
  readonly toolCount: number;
  readonly tools: readonly string[];
  readonly elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export const pingCommand: LifecycleCommand = {
  name: 'ping',
  description: 'Spawn `memento serve`, list tools over MCP stdio, exit',
  run: runPing,
};

export async function runPing(
  _deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<PingSnapshot>> {
  const start = Date.now();
  // Resolve the child entrypoint. Re-invoking the same Node
  // executable with our own bin script keeps the test harness
  // hermetic — no PATH lookup, no version drift between parent
  // and child.
  const argv0 = process.execPath;
  const binPath = process.argv[1] ?? '';
  if (binPath === '') {
    return err({ code: 'INVALID_INPUT', message: 'cannot resolve memento bin path for ping' });
  }
  const child = spawn(argv0, [binPath, 'serve'], {
    env: { ...process.env, MEMENTO_DB: input.env.dbPath, MEMENTO_INIT_DONE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  let buffer = '';
  const messages: Array<Record<string, unknown>> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          messages.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // skip non-JSON noise (e.g. stray banner output)
        }
      }
      nl = buffer.indexOf('\n');
    }
  });

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, DEFAULT_TIMEOUT_MS);

  const send = (msg: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memento-ping', version: resolveVersion() },
    },
  });

  // Wait briefly for initialize response, then list tools.
  await waitForResponse(messages, 1, DEFAULT_TIMEOUT_MS);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listResult = await waitForResponse(messages, 2, DEFAULT_TIMEOUT_MS);
  clearTimeout(timeout);
  child.stdin.end();
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(500)]);

  if (listResult === undefined) {
    return err({
      code: 'INTERNAL',
      message: `ping: no tools/list response within ${DEFAULT_TIMEOUT_MS}ms${stderr ? ` (stderr: ${stderr.trim().slice(0, 200)})` : ''}`,
    });
  }
  const tools =
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
    (listResult['result'] as { tools?: ReadonlyArray<{ name: string }> } | undefined)?.tools ?? [];
  return ok({
    version: resolveVersion(),
    toolCount: tools.length,
    tools: tools.map((t) => t.name),
    elapsedMs: Date.now() - start,
  });
}

async function waitForResponse(
  messages: Array<Record<string, unknown>>,
  id: number,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
    const found = messages.find((m) => m['id'] === id);
    if (found !== undefined) return found;
    await delay(20);
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
