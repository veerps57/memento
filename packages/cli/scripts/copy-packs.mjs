#!/usr/bin/env node
// Stage the workspace-root `packs/` directory inside `packages/cli/packs/`
// so the published npm tarball ships the bundled-pack registry.
//
// Source of truth lives at `<workspace-root>/packs/` so reviewers,
// docs, and ADRs reference one canonical location. The npm `files`
// array on `package.json` cannot reach across workspace boundaries
// (no `..` segments), so on every CLI build we stage a copy under
// `packages/cli/packs/` (gitignored) that the publish step picks up.
//
// Idempotent: clears the existing staged copy before re-copying so a
// renamed or removed pack never lingers from a previous build.
//
// Runtime path resolution. Once shipped, the CLI's `runCli` entry
// point in `packages/cli/src/run.ts` resolves the staged directory
// relative to its own bundled location (sibling of `dist/`) and
// passes it as the runtime default for `packs.bundledRegistryPath`.
// That makes `memento pack install <id>` work out of the box for end
// users — no manual config required.
//
// Runs in the consumer's environment only at build time, so it uses
// Node built-ins exclusively (no dependencies). Failures fail the
// build loud — a missing source directory means the tarball would
// ship without the bundled packs, and surfacing that early is the
// right call.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..'); // packages/cli
const workspaceRoot = resolve(cliRoot, '..', '..'); // repo root
const source = resolve(workspaceRoot, 'packs');
const dest = resolve(cliRoot, 'packs');

if (!existsSync(source)) {
  process.stderr.write(`copy-packs: source not found: ${source}\n`);
  process.exit(1);
}

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}
cpSync(source, dest, { recursive: true });
