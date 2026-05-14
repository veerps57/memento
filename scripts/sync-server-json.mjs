#!/usr/bin/env node
// Sync `server.json` version fields and validate `mcpName` against
// `packages/cli/package.json`.
//
// Why this exists
// ---------------
//
// The official MCP Registry rejects publishes whose `server.json.version`
// (or `server.json.packages[0].version`) differs from the npm tarball's
// `package.json.version`, and rejects publishes whose tarball
// `package.json.mcpName` differs from `server.json.name`. Two committed
// sources of truth for the same string would silently drift; this script
// collapses them to one — the CLI `package.json` — and writes/checks the
// rest. See [ADR-0022](../docs/adr/0022-mcp-registry-publishing.md).
//
// Modes
// -----
//
//   --write   rewrite `server.json.version` and
//             `server.json.packages[0].version` from
//             `packages/cli/package.json.version`. Invoked from the root
//             `version-packages` script so changesets-driven version bumps
//             propagate atomically.
//   --check   read-only; exit non-zero if any of these invariants are
//             violated:
//               - `server.json.version` != cli version
//               - `server.json.packages[0].version` != cli version
//               - `cli.mcpName` != `server.json.name`
//             Wired into `pnpm verify` so any path that bumps the CLI
//             without going through `version-packages` (e.g. a manual
//             edit) fails CI.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_JSON_PATH = resolve(ROOT, 'server.json');
const CLI_PACKAGE_JSON_PATH = resolve(ROOT, 'packages/cli/package.json');

const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : null;
if (!mode) {
  console.error('Usage: sync-server-json.mjs --write | --check');
  process.exit(2);
}

const cli = JSON.parse(readFileSync(CLI_PACKAGE_JSON_PATH, 'utf8'));
const server = JSON.parse(readFileSync(SERVER_JSON_PATH, 'utf8'));

const expectedVersion = cli.version;
const expectedName = server.name;
const cliMcpName = cli.mcpName;

if (!Array.isArray(server.packages) || server.packages.length === 0) {
  console.error('server.json.packages is missing or empty; cannot sync.');
  process.exit(1);
}

if (mode === 'check') {
  const issues = [];
  if (server.version !== expectedVersion) {
    issues.push(
      `server.json.version (${server.version}) != packages/cli/package.json.version (${expectedVersion})`,
    );
  }
  const pkgVersion = server.packages[0].version;
  if (pkgVersion !== expectedVersion) {
    issues.push(
      `server.json.packages[0].version (${pkgVersion}) != packages/cli/package.json.version (${expectedVersion})`,
    );
  }
  if (cliMcpName !== expectedName) {
    issues.push(
      `packages/cli/package.json.mcpName (${JSON.stringify(cliMcpName)}) != server.json.name (${JSON.stringify(expectedName)})`,
    );
  }
  if (issues.length > 0) {
    console.error('server.json invariants violated:');
    for (const issue of issues) console.error(`  - ${issue}`);
    console.error(
      '\nRun `node scripts/sync-server-json.mjs --write` to update server.json from the CLI version,',
    );
    console.error('or edit packages/cli/package.json.mcpName to match server.json.name.');
    process.exit(1);
  }
  console.log(`server.json invariants OK (version ${expectedVersion}, name ${expectedName}).`);
  process.exit(0);
}

server.version = expectedVersion;
server.packages[0].version = expectedVersion;
writeFileSync(SERVER_JSON_PATH, `${JSON.stringify(server, null, 2)}\n`, 'utf8');
console.log(`server.json synced to version ${expectedVersion}.`);
