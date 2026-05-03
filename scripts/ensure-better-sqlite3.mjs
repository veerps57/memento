#!/usr/bin/env node
// Workspace postinstall: self-heal the better-sqlite3 native binding.
//
// Why this exists
// ---------------
//
// pnpm 10's install lifecycle runs better-sqlite3's install hook
// (`prebuild-install`) and reports "Done", but the fetch silently
// no-ops in some pnpm-store layouts, leaving
// `build/Release/better_sqlite3.node` absent. The first command
// that touches SQLite then crashes with
// `Error: Could not locate the bindings file`.
//
// CI works around this with an explicit step in
// `.github/workflows/ci.yml`. This script is the local-dev
// equivalent so no contributor is one cryptic error away from
// giving up after `pnpm install` (or after `nvm use` to a Node
// version with a different ABI).
//
// The published-package self-heal lives in
// `packages/cli/scripts/postinstall.mjs` and runs in the
// end-user's `node_modules` layout. This script is workspace-
// only: it walks `node_modules/.pnpm/` (pnpm's content-addressed
// store) and uses the fast prebuild-fetch path.
//
// What this script does
// ---------------------
//
// 1. Probe by file existence: check whether `better_sqlite3.node`
//    is present under the located pnpm package dir. (We can't
//    `require('better-sqlite3')` from this script's location —
//    it isn't a root dep — so a `require` probe always fails
//    and yields no signal.)
// 2. Fast path: run `prebuild-install --runtime=node` inside the
//    package dir to fetch the prebuilt binary for the current
//    Node ABI. Stderr is inherited so failures are visible.
// 3. Slow path: if no prebuild exists for this platform, fall
//    back to `npm rebuild better-sqlite3 --build-from-source`
//    (requires a C++ toolchain).
// 4. Never fail the install. If every path fails, log a clear
//    warning with a copy-pasteable manual fix and exit 0.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PKG_NAME = 'better-sqlite3';
const BINARY_REL_PATH = join('build', 'Release', 'better_sqlite3.node');

// Environment allow-list for child-process invocations.
//
// Forwarding the parent `process.env` verbatim is a documented
// supply-chain hazard during `npm install` / `pnpm install`: any
// other dep's postinstall can stage env vars that this script's
// child npm/npx then honours. The classic exploit shapes:
//
//   - `npm_config_script_shell` redirects `npm rebuild`'s install
//     script through an attacker-chosen shell;
//   - `npm_config_registry`, `npm_config_userconfig`,
//     `npm_config_prefix` quietly redirect package fetch and config
//     resolution;
//   - `NODE_OPTIONS=--require=./malicious.js` lets a colluding
//     package load arbitrary code into our spawned `node` process;
//   - `PREBUILD_INSTALL_HOST` / `npm_config_better_sqlite3_binary_host_mirror`
//     redirect where `prebuild-install` downloads the prebuilt
//     binary from, substituting a malicious native module.
//
// We forward only the variables the legitimate workflow needs:
// `PATH` (to find tools), the platform's home / temp / system
// dirs (npm itself reads them), and `npm_execpath` /
// `npm_node_execpath` so the child npm finds its own runtime.
// `npm_config_cache` is forwarded because the install would
// otherwise re-download into a fresh cache. Everything else —
// notably every other `npm_config_*`, `NODE_OPTIONS`,
// `NODE_PATH`, `*_BINARY_HOST*`, etc. — is dropped.
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'npm_config_cache',
  'npm_execpath',
  'npm_node_execpath',
];

function safeEnv() {
  const out = Object.create(null);
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Resolve the `npm` / `npx` binary the parent install is using.
 *
 * `process.env.npm_execpath` points at the running npm's
 * `npm-cli.js` (set by npm itself for every postinstall hook).
 * Invoking it via `node $execpath ...` bypasses any
 * `node_modules/.bin/npm` override that a malicious sibling dep
 * might have planted on `PATH`. The same dir holds `npx-cli.js`,
 * which is the npx counterpart.
 *
 * Fallback to a bare `PATH` lookup only when `npm_execpath` is
 * unset (e.g. somebody invoking the script outside an
 * install context).
 */
function resolveNpmCli(name) {
  const execpath = process.env.npm_execpath;
  if (typeof execpath === 'string' && existsSync(execpath)) {
    if (name === 'npm') {
      return { command: process.execPath, args: [execpath] };
    }
    if (name === 'npx') {
      const npxPath = join(dirname(execpath), 'npx-cli.js');
      if (existsSync(npxPath)) {
        return { command: process.execPath, args: [npxPath] };
      }
    }
  }
  return {
    command: process.platform === 'win32' ? `${name}.cmd` : name,
    args: [],
  };
}

function findPkgDir() {
  const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${PKG_NAME}@`)) continue;
    const pkgDir = join(pnpmDir, entry.name, 'node_modules', PKG_NAME);
    if (existsSync(pkgDir)) return pkgDir;
  }
  return null;
}

function bindingExists(pkgDir) {
  return existsSync(join(pkgDir, BINARY_REL_PATH));
}

function fetchPrebuild(pkgDir) {
  console.error(`memento: fetching ${PKG_NAME} prebuild via prebuild-install...`);
  const cli = resolveNpmCli('npx');
  const result = spawnSync(
    cli.command,
    [...cli.args, '--yes', 'prebuild-install', '--runtime=node'],
    { cwd: pkgDir, stdio: 'inherit', env: safeEnv() },
  );
  return result.status === 0;
}

function rebuildFromSource(pkgDir) {
  console.error(
    `memento: prebuild fetch did not place the binding; rebuilding ${PKG_NAME} from source...`,
  );
  const cli = resolveNpmCli('npm');
  const result = spawnSync(cli.command, [...cli.args, 'rebuild', PKG_NAME, '--build-from-source'], {
    cwd: pkgDir,
    stdio: 'inherit',
    env: safeEnv(),
  });
  return result.status === 0;
}

const pkgDir = findPkgDir();
if (!pkgDir) {
  // Not an error: the workspace might be installed without the dep
  // graph that pulls in better-sqlite3 (unlikely, but harmless).
  process.exit(0);
}

if (bindingExists(pkgDir)) {
  // Healthy install. The lifecycle hook actually worked. Silent.
  process.exit(0);
}

// Fast path: fetch the prebuilt binary.
fetchPrebuild(pkgDir);
if (bindingExists(pkgDir)) {
  console.error(`memento: healed ${PKG_NAME} via prebuild-install`);
  process.exit(0);
}

// Slow path: rebuild from source. Requires a C++ toolchain.
rebuildFromSource(pkgDir);
if (bindingExists(pkgDir)) {
  console.error(`memento: rebuilt ${PKG_NAME} from source`);
  process.exit(0);
}

console.error('');
console.error(`memento: WARNING — could not heal ${PKG_NAME} native binding.`);
console.error('memento: tests and the CLI will fail with "Could not locate the bindings file".');
console.error('memento: try manually:');
console.error(`memento:   (cd ${pkgDir} && npx --yes prebuild-install --runtime=node)`);
console.error(
  'memento: or, if no prebuild exists for your platform, install a C++ toolchain and run:',
);
console.error(`memento:   pnpm rebuild ${PKG_NAME}`);
process.exit(0);
