#!/usr/bin/env node
// Stage the workspace-root `skills/` directory inside `packages/cli/skills/`
// so the published npm tarball ships the skill bundle.
//
// Source of truth lives at `<workspace-root>/skills/` so reviewers,
// docs, and ADRs reference one canonical location. The npm `files`
// array on `package.json` cannot reach across workspace boundaries
// (no `..` segments), so on every CLI build we stage a copy under
// `packages/cli/skills/` (gitignored) that the publish step picks up.
//
// Idempotent: clears the existing staged copy before re-copying so a
// renamed or removed skill never lingers from a previous build.
//
// Runs in the consumer's environment only at build time, so it uses
// Node built-ins exclusively (no dependencies). Failures fail the
// build loud — a missing source directory means the tarball would
// ship without the skill, and surfacing that early is the right call.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..'); // packages/cli
const workspaceRoot = resolve(cliRoot, '..', '..'); // repo root
const source = resolve(workspaceRoot, 'skills');
const dest = resolve(cliRoot, 'skills');

if (!existsSync(source)) {
  process.stderr.write(`copy-skills: source not found: ${source}\n`);
  process.exit(1);
}

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}
cpSync(source, dest, { recursive: true });
