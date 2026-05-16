#!/usr/bin/env node
// Dev-server runner for the landing package.
//
// Why this exists
// ---------------
//
// `pnpm dev:landing` invokes vite, and a typical Ctrl-C makes
// vite exit with code 130 (the standard SIGINT exit). pnpm
// interprets any non-zero exit as a failed script and prints
// `ELIFECYCLE Command failed.`, which makes a deliberate stop
// look like an error to anyone running the script.
//
// This wrapper spawns vite, forwards SIGINT/SIGTERM to it, and
// translates the SIGINT/SIGTERM exit back to a clean exit 0 — so
// Ctrl-C is silent. Real crashes (non-signal non-zero exits)
// still propagate so they remain visible.
//
// Cross-platform: pure Node, no shell tricks.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const landingDir = resolve(here, '..', 'packages', 'landing');

// Forward any CLI args to vite (e.g. `pnpm dev:landing --port 5176`).
const passthrough = process.argv.slice(2);
const child = spawn('pnpm', ['exec', 'vite', ...passthrough], {
  cwd: landingDir,
  stdio: 'inherit',
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('exit', (code, signal) => {
  // SIGINT / SIGTERM are deliberate stops; not failures.
  // Exit codes 130 (128 + SIGINT) and 143 (128 + SIGTERM) are
  // the Unix convention for the same.
  if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 130 || code === 143) {
    process.exit(0);
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  process.stderr.write(`dev-landing: failed to spawn vite — ${err.message}\n`);
  process.exit(1);
});
