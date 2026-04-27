#!/usr/bin/env node
// Postinstall self-heal for the better-sqlite3 native binding.
//
// Why this exists
// ---------------
//
// `better-sqlite3` ships a precompiled native binding via
// `prebuild-install`. The npm-published binaries cover most
// (Node major × OS × arch) combinations, but not all. The two
// failure modes a fresh user actually hits are:
//
//   1. NODE_MODULE_VERSION mismatch — the user installed memento
//      under one Node version, then `nvm use`-d to another. The
//      old binding is ABI-incompatible with the new runtime, so
//      the first `memento` invocation crashes with
//      `ERR_DLOPEN_FAILED`.
//
//   2. No prebuilt binary for the host (e.g. Alpine + musl,
//      uncommon arch). `prebuild-install` silently falls back
//      to `node-gyp rebuild`, which works iff a C++ toolchain is
//      installed; otherwise the install half-completes and
//      memento crashes opaquely on first use.
//
// What this script does
// ---------------------
//
// On the install path (right after npm/pnpm/yarn copies our
// files into the consumer's `node_modules`), try to load
// `better-sqlite3` and instantiate an in-memory database. If
// that succeeds the binding is healthy and we return silently.
// If it fails we run `npm rebuild better-sqlite3 --build-from-source`
// and try once more, swallowing the noise on the success path.
//
// What this script must NOT do
// ----------------------------
//
//   - Never `process.exit(1)` on failure. Failing the install
//     for an optional self-heal is worse than letting the user
//     run `memento doctor` (which now fingerprints exactly this
//     class of failure with a rebuild hint).
//   - Never log on the success path. A silent successful
//     install is the only acceptable UX during `npm install`.
//   - Never pull in dependencies. This file runs in the
//     consumer's environment and must use only Node built-ins.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function tryLoadBinding() {
  try {
    const Database = require('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause };
  }
}

function rebuild() {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['rebuild', 'better-sqlite3', '--build-from-source'],
      {
        stdio: 'ignore',
        env: process.env,
      },
    );
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  const first = tryLoadBinding();
  if (first.ok) return; // healthy install — silence is the UX

  // Best-effort rebuild. If it works, silence again.
  const rebuilt = await rebuild();
  if (!rebuilt) {
    // Don't fail the install. The first command the user runs
    // (e.g. `memento doctor`) reports a precise hint and a
    // copy-pasteable rebuild command. That is a better UX than
    // an `npm install` that exits non-zero in the middle of a
    // larger workflow.
    return;
  }
  const second = tryLoadBinding();
  // Either way we return success; the user-facing diagnostic
  // path lives in `memento doctor`, not in this install hook.
  void second;
}

main().catch(() => {
  // Mirror the rebuild fallthrough: never fail install.
});
