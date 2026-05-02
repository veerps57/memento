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
import { join } from 'node:path';

const PKG_NAME = 'better-sqlite3';
const BINARY_REL_PATH = join('build', 'Release', 'better_sqlite3.node');

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
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', 'prebuild-install', '--runtime=node'],
    { cwd: pkgDir, stdio: 'inherit', env: process.env },
  );
  return result.status === 0;
}

function rebuildFromSource(pkgDir) {
  console.error(
    `memento: prebuild fetch did not place the binding; rebuilding ${PKG_NAME} from source...`,
  );
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['rebuild', PKG_NAME, '--build-from-source'],
    { cwd: pkgDir, stdio: 'inherit', env: process.env },
  );
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
