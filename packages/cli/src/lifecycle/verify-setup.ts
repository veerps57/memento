// `memento verify-setup` — end-to-end MCP wiring round-trip
// against a real spawned server process.
//
// Why this command exists
// -----------------------
//
// `memento doctor` confirms the host can run the server (Node
// version, DB writable, native binding, embedder peer); `doctor
// --mcp` validates known client config files. Neither command
// exercises the loop an AI assistant actually performs: spawn
// the binary, complete the MCP handshake, list tools, write a
// memory, search for it, clean up. Users were finding out the
// wiring was broken only when their assistant silently failed
// mid-session.
//
// `verify-setup` runs that loop end-to-end. By default it
// **spawns the CLI as a subprocess and talks to it over
// stdio** — the same shape every real MCP client uses. That
// catches "node not in PATH", "the binary won't start", "the
// MCP SDK versions disagree", and any other failure that lives
// between the binary and the wire. The fallback in-memory
// transport (`--engine-only`) is preserved for dev / CI
// environments where spawning a fresh node is wasteful.
//
// Rationale: ADR-0028.
//
// What it does
// ------------
//
//   1. Spawn `node <self>/cli.js serve` as a subprocess with
//      `MEMENTO_DB` set to the user's resolved DB path.
//   2. Connect an MCP `Client` to it via stdio.
//   3. Walk the smoke-test sequence:
//        - initialize → read `instructions` (ADR-0026)
//        - tools/list                     — surface enumerated
//        - info_system                    — server health probe
//        - write_memory                   — transient test memory
//        - search_memory                  — round-trip read
//        - forget_memory (with reason)    — clean up
//   4. Each step lands as a `VerifyCheck` in the snapshot; the
//      first failure short-circuits with a descriptive message.
//
// What it does NOT do
// -------------------
//
//   - Spawn `npx -y @psraghuveer/memento serve`. That spawn vector
//     is what the user's MCP config carries; `doctor --mcp`
//     validates the config file's shape. `verify-setup` spawns
//     the locally-resolved CLI binary so the test is reliable
//     across machines and offline.
//   - Validate cross-client compatibility. We test against the
//     SDK's reference Client implementation; if a third-party
//     client is non-compliant, that surfaces elsewhere.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CommandContext } from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';
import { buildMementoServer } from '@psraghuveer/memento-server';

import { resolveVersion } from '../version.js';
import { openAppForSurface } from './open-app.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** One round-trip check. Shape mirrors `doctor`'s `DoctorCheck` for renderer reuse. */
export interface VerifyCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  /** Elapsed millis for the round-trip step. Useful for diagnosing slow embedders. */
  readonly elapsedMs?: number;
}

/** Stable contract for `memento verify-setup`. */
export interface VerifySetupSnapshot {
  readonly version: string;
  readonly dbPath: string;
  /**
   * Which transport the round-trip used:
   *   - `'subprocess'` (default) — spawned `node <cli> serve` and talked over stdio.
   *   - `'engine-only'` — fell back to in-process build-server + InMemoryTransport.
   *     Set via the `--engine-only` flag, or automatically when the CLI's own
   *     `dist/cli.js` cannot be resolved (a dev tree that hasn't built).
   */
  readonly transport: 'subprocess' | 'engine-only';
  /** True iff every check returned ok. */
  readonly ok: boolean;
  readonly checks: readonly VerifyCheck[];
}

// Tag stamped on the transient test memory so a re-run after a
// crash can detect and reap stale rows.
const VERIFY_TAG = 'memento:verify-setup';

const CTX: CommandContext = { actor: { type: 'cli' } };

export const verifySetupCommand: LifecycleCommand = {
  name: 'verify-setup',
  description: 'Spawn the MCP server and round-trip a write/read to prove the wiring works',
  run: runVerifySetup,
};

interface VerifySetupSubargs {
  readonly engineOnly: boolean;
}

function parseSubargs(subargs: readonly string[]): Result<VerifySetupSubargs> {
  let engineOnly = false;
  for (const arg of subargs) {
    if (arg === '--engine-only') {
      engineOnly = true;
      continue;
    }
    return err({
      code: 'INVALID_INPUT',
      message: `unknown argument '${arg}' for 'verify-setup' (accepted: --engine-only)`,
    });
  }
  return ok({ engineOnly });
}

export async function runVerifySetup(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<VerifySetupSnapshot>> {
  const parsed = parseSubargs(input.subargs);
  if (!parsed.ok) return parsed;
  const { engineOnly } = parsed.value;

  // Resolve the CLI binary path for the subprocess spawn. When
  // we can't find a built `dist/cli.js` (dev tree without
  // `pnpm build`), fall back to engine-only mode so the command
  // still produces a useful signal rather than erroring out.
  const resolvedCliPath = engineOnly ? null : resolveSelfCliPath();
  const useSubprocess = !engineOnly && resolvedCliPath !== null;

  if (useSubprocess) {
    return runSubprocessVerification({
      cliPath: resolvedCliPath as string,
      dbPath: input.env.dbPath,
      env: input.io.env,
    });
  }

  // Engine-only path: explicitly opted in, OR the binary
  // couldn't be resolved (dev / CI without a build).
  return runEngineOnlyVerification(deps, input);
}

/**
 * Spawn `node <cliPath> serve` and connect via stdio. This is
 * the default and what makes `verify-setup` materially different
 * from `doctor` — we test the binary actually starts, the MCP
 * handshake completes, and every routine tool round-trips.
 */
async function runSubprocessVerification(opts: {
  readonly cliPath: string;
  readonly dbPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<Result<VerifySetupSnapshot>> {
  const checks: VerifyCheck[] = [];
  let ok_ = true;

  // Strip undefined values; StdioClientTransport requires
  // `Record<string, string>`. The default shape inherits from
  // the caller's env so PATH / NODE_PATH / etc. are present.
  const subprocessEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string') subprocessEnv[k] = v;
  }
  // The user's resolved DB path — same one a real MCP client
  // would set in its config file's `env` block.
  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
  subprocessEnv['MEMENTO_DB'] = opts.dbPath;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [opts.cliPath, 'serve'],
    env: subprocessEnv,
  });
  const client = new Client({ name: 'memento-verify-setup', version: resolveVersion() });

  // — spawn + initialize —
  const spawnCheck = await timed('spawn-and-initialize', async () => {
    try {
      await client.connect(transport);
      return {
        ok: true,
        message: `spawned \`node ${path.basename(opts.cliPath)} serve\` and completed MCP initialize`,
      };
    } catch (cause) {
      return {
        ok: false,
        message: `failed to spawn or initialize MCP server: ${describe(cause)}`,
      };
    }
  });
  checks.push(spawnCheck);
  if (!spawnCheck.ok) {
    return ok({
      version: resolveVersion(),
      dbPath: opts.dbPath,
      transport: 'subprocess',
      ok: false,
      checks,
    });
  }

  // — instructions field (ADR-0026) —
  // After initialize, the spine should be available via
  // `client.getInstructions()`. A missing field means either the
  // server is older than the launch that introduced ADR-0026, or
  // the wiring was severed in a refactor — both are regressions
  // we want to catch loudly.
  const instructionsCheck = await timed('instructions-field', async () => {
    const instructions = client.getInstructions();
    if (typeof instructions !== 'string' || instructions.length === 0) {
      return {
        ok: false,
        message:
          'server did not emit an `instructions` field on initialize (ADR-0026). Spec-compliant MCP clients will not inject any session-start guidance — assistants will start sessions cold.',
      };
    }
    return {
      ok: true,
      message: `instructions field present (${instructions.length} chars) — clients will inject the session-start spine into the assistant's system prompt`,
    };
  });
  checks.push(instructionsCheck);
  if (!instructionsCheck.ok) ok_ = false;

  let testMemoryId: string | undefined;

  try {
    const toolsCheck = await runToolsListCheck(client);
    checks.push(toolsCheck);
    if (!toolsCheck.ok) ok_ = false;

    if (ok_) {
      const infoCheck = await runInfoSystemCheck(client);
      checks.push(infoCheck);
      if (!infoCheck.ok) ok_ = false;
    }

    if (ok_) {
      const writeResult = await runWriteMemoryCheck(client);
      checks.push(writeResult.check);
      if (!writeResult.check.ok) ok_ = false;
      testMemoryId = writeResult.id;
    }

    if (ok_) {
      const searchCheck = await runSearchMemoryCheck(client, testMemoryId);
      checks.push(searchCheck);
      if (!searchCheck.ok) ok_ = false;
    }
  } finally {
    if (testMemoryId !== undefined) {
      checks.push(await runCleanupCheck(client, testMemoryId));
    }
    try {
      await client.close();
    } catch {
      // Best-effort.
    }
  }

  return ok({
    version: resolveVersion(),
    dbPath: opts.dbPath,
    transport: 'subprocess',
    ok: ok_,
    checks,
  });
}

/**
 * Fallback / dev path: in-process `buildMementoServer` paired
 * with an in-memory client. Loses the spawn-coverage but is
 * still a useful engine-layer round-trip when the binary isn't
 * resolvable (e.g. a contributor running from `src/`).
 */
async function runEngineOnlyVerification(
  deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<VerifySetupSnapshot>> {
  const opened = await openAppForSurface(deps, {
    dbPath: input.env.dbPath,
    appVersion: resolveVersion(),
  });
  if (!opened.ok) return opened;
  const app = opened.value;

  const checks: VerifyCheck[] = [];
  let ok_ = true;

  const server = buildMementoServer({
    registry: app.registry,
    ctx: CTX,
    info: { name: '@psraghuveer/memento-server', version: resolveVersion() },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'memento-verify-setup', version: resolveVersion() });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  } catch (cause) {
    await app.shutdown();
    return err({
      code: 'INTERNAL',
      message: `verify-setup (engine-only): in-memory MCP handshake failed: ${describe(cause)}`,
    });
  }

  let testMemoryId: string | undefined;

  try {
    const toolsCheck = await runToolsListCheck(client);
    checks.push(toolsCheck);
    if (!toolsCheck.ok) ok_ = false;

    if (ok_) {
      const infoCheck = await runInfoSystemCheck(client);
      checks.push(infoCheck);
      if (!infoCheck.ok) ok_ = false;
    }

    if (ok_) {
      const writeResult = await runWriteMemoryCheck(client);
      checks.push(writeResult.check);
      if (!writeResult.check.ok) ok_ = false;
      testMemoryId = writeResult.id;
    }

    if (ok_) {
      const searchCheck = await runSearchMemoryCheck(client, testMemoryId);
      checks.push(searchCheck);
      if (!searchCheck.ok) ok_ = false;
    }
  } finally {
    if (testMemoryId !== undefined) {
      checks.push(await runCleanupCheck(client, testMemoryId));
    }
    try {
      await client.close();
    } catch {
      // Best-effort.
    }
    await app.shutdown();
  }

  return ok({
    version: resolveVersion(),
    dbPath: input.env.dbPath,
    transport: 'engine-only',
    ok: ok_,
    checks,
  });
}

// — Shared per-step check helpers (used by both transports) —

async function runToolsListCheck(client: Client): Promise<VerifyCheck> {
  return timed('tools-list', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const requiredTools = [
      'info_system',
      'get_memory_context',
      'write_memory',
      'search_memory',
      'forget_memory',
    ];
    const missing = requiredTools.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      return {
        ok: false,
        message: `tools/list returned ${names.length} tools but is missing: ${missing.join(', ')}`,
      };
    }
    return {
      ok: true,
      message: `tools/list returned ${names.length} tools, all required ones present`,
    };
  });
}

async function runInfoSystemCheck(client: Client): Promise<VerifyCheck> {
  return timed('info-system', async () => {
    const result = await client.callTool({ name: 'info_system', arguments: {} });
    if (result.isError) {
      return { ok: false, message: `info_system returned isError: ${textOf(result)}` };
    }
    const parsed = parseToolJson(result);
    if (parsed === null) {
      return { ok: false, message: `info_system returned non-JSON payload: ${textOf(result)}` };
    }
    const version = (parsed as { version?: string }).version ?? '<unknown>';
    const counts = (parsed as { counts?: Record<string, number> }).counts ?? {};
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
    const active = counts['active'] ?? 0;
    return {
      ok: true,
      message: `server v${version} healthy; ${active} active memor${active === 1 ? 'y' : 'ies'} in store`,
    };
  });
}

async function runWriteMemoryCheck(
  client: Client,
): Promise<{ check: VerifyCheck; id: string | undefined }> {
  let capturedId: string | undefined;
  const check = await timed('write-memory', async () => {
    const result = await client.callTool({
      name: 'write_memory',
      arguments: {
        scope: { type: 'global' },
        kind: { type: 'snippet', language: 'shell' },
        tags: [VERIFY_TAG],
        content: 'memento verify-setup: round-trip probe',
        summary: null,
      },
    });
    if (result.isError) {
      return { ok: false, message: `write_memory returned isError: ${textOf(result)}` };
    }
    const parsed = parseToolJson(result);
    const id = (parsed as { id?: string } | null)?.id;
    if (typeof id !== 'string') {
      return {
        ok: false,
        message: `write_memory did not return an id field; got: ${textOf(result)}`,
      };
    }
    capturedId = id;
    return { ok: true, message: `wrote test memory ${id}` };
  });
  return { check, id: capturedId };
}

async function runSearchMemoryCheck(
  client: Client,
  expectedId: string | undefined,
): Promise<VerifyCheck> {
  return timed('search-memory', async () => {
    const result = await client.callTool({
      name: 'search_memory',
      arguments: { text: 'verify-setup round-trip probe', tags: [VERIFY_TAG] },
    });
    if (result.isError) {
      return { ok: false, message: `search_memory returned isError: ${textOf(result)}` };
    }
    const parsed = parseToolJson(result);
    const results = (parsed as { results?: readonly { memory?: { id?: string } }[] } | null)
      ?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return { ok: false, message: 'search_memory returned no matches for the test memory' };
    }
    const found = results.some((r) => r.memory?.id === expectedId);
    if (!found) {
      return {
        ok: false,
        message: `search_memory returned ${results.length} hit(s) but none matched the test memory id`,
      };
    }
    return {
      ok: true,
      message: `search_memory found the test memory among ${results.length} hit(s)`,
    };
  });
}

async function runCleanupCheck(client: Client, testMemoryId: string): Promise<VerifyCheck> {
  try {
    const forgetResult = await client.callTool({
      name: 'forget_memory',
      arguments: {
        id: testMemoryId,
        reason: 'verify-setup teardown',
        confirm: true,
      },
    });
    if (forgetResult.isError) {
      return {
        name: 'cleanup',
        ok: false,
        message: `cleanup of test memory ${testMemoryId} failed: ${textOf(forgetResult)}. Run \`memento forget ${testMemoryId} --reason 'verify-setup leftover' --confirm\` to remove it.`,
      };
    }
    return {
      name: 'cleanup',
      ok: true,
      message: `cleaned up test memory ${testMemoryId}`,
    };
  } catch (cause) {
    return {
      name: 'cleanup',
      ok: false,
      message: `cleanup of test memory ${testMemoryId} threw: ${describe(cause)}`,
    };
  }
}

/**
 * Walk up from this module's file looking for the sibling
 * `dist/cli.js`. Returns the absolute path when found, or `null`
 * to signal the engine-only fallback.
 *
 * Layout assumption: the bundled CLI ships from
 * `<package-root>/dist/cli.js` and this file lives at
 * `<package-root>/dist/<chunk>.js` (production tarball) or
 * `<package-root>/src/lifecycle/verify-setup.ts` (in-source).
 * Both resolve to the same `<package-root>/dist/cli.js`.
 */
function resolveSelfCliPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 1; depth <= 4; depth += 1) {
    const ascent = Array.from({ length: depth }, () => '..');
    const candidate = path.resolve(here, ...ascent, 'dist', 'cli.js');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Wrap a check with elapsed-time measurement. */
async function timed(
  name: string,
  body: () => Promise<{ ok: boolean; message: string }>,
): Promise<VerifyCheck> {
  const start = performance.now();
  try {
    const { ok: okFlag, message } = await body();
    const elapsedMs = Math.round(performance.now() - start);
    return { name, ok: okFlag, message, elapsedMs };
  } catch (cause) {
    const elapsedMs = Math.round(performance.now() - start);
    return { name, ok: false, message: `${name} threw: ${describe(cause)}`, elapsedMs };
  }
}

/** Extract the text content from a CallToolResult, or `'(no text)'` if absent. */
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (result as { content?: readonly { type?: string; text?: string }[] }).content;
  if (!Array.isArray(content) || content.length === 0) return '(no text)';
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** Parse the JSON payload from a successful tool call, returning null on parse failure. */
function parseToolJson(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const text = textOf(result);
  if (text === '(no text)') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
