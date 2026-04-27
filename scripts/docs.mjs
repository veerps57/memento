#!/usr/bin/env node
// Reference-doc generator. Produces the four files under
// `docs/reference/` from in-source registries:
//
//   - `mcp-tools.md`   from the command registry (mcp surface)
//   - `cli.md`         from the command registry (cli surface)
//   - `config-keys.md` from `CONFIG_KEYS`
//   - `error-codes.md` from `ERROR_CODES` + `ERROR_CODE_DESCRIPTIONS`
//
// Modes:
//
//   `--write`   (default) — render and overwrite the files on disk.
//   `--check`             — render in memory, diff against disk,
//                           print drift, exit non-zero on any
//                           mismatch. CI uses this to keep the
//                           generated docs honest.
//
// The script imports from the package builds (`packages/*/dist`).
// Run via the root package.json scripts; they pre-build the
// schema and core packages before invoking this runner.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIFECYCLE_COMMANDS } from '../packages/cli/dist/index.js';
import {
  createMementoApp,
  renderCliDoc,
  renderConfigKeysDoc,
  renderErrorCodesDoc,
  renderMcpToolsDoc,
} from '../packages/core/dist/index.js';
import { CONFIG_KEYS } from '../packages/schema/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_DIR = resolve(ROOT, 'docs/reference');

const MODE_WRITE = 'write';
const MODE_CHECK = 'check';

function parseMode(argv) {
  const flags = argv.slice(2);
  if (flags.includes('--check')) return MODE_CHECK;
  if (flags.includes('--write') || flags.length === 0) return MODE_WRITE;
  throw new Error(`unknown flag: ${flags.join(' ')}. Use --write (default) or --check.`);
}

async function readExisting(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function buildDocs() {
  // The registry needs a live app instance because commands are
  // built from repositories. An in-memory database is sufficient
  // — we never touch the data plane, only the metadata.
  const app = await createMementoApp({ dbPath: ':memory:' });
  try {
    const commands = app.registry.list();
    const lifecycle = Object.values(LIFECYCLE_COMMANDS).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
    return [
      {
        path: resolve(REFERENCE_DIR, 'mcp-tools.md'),
        content: renderMcpToolsDoc(commands),
      },
      {
        path: resolve(REFERENCE_DIR, 'cli.md'),
        content: renderCliDoc(commands, lifecycle),
      },
      {
        path: resolve(REFERENCE_DIR, 'config-keys.md'),
        content: renderConfigKeysDoc(CONFIG_KEYS),
      },
      {
        path: resolve(REFERENCE_DIR, 'error-codes.md'),
        content: renderErrorCodesDoc(),
      },
    ];
  } finally {
    app.close();
  }
}

async function main() {
  const mode = parseMode(process.argv);
  const docs = await buildDocs();

  if (mode === MODE_WRITE) {
    for (const doc of docs) {
      await writeFile(doc.path, doc.content, 'utf8');
      const rel = doc.path.slice(ROOT.length + 1);
      process.stdout.write(`wrote ${rel}\n`);
    }
    return 0;
  }

  // --check
  const drift = [];
  for (const doc of docs) {
    const onDisk = await readExisting(doc.path);
    if (onDisk !== doc.content) {
      drift.push({ path: doc.path, onDisk, expected: doc.content });
    }
  }
  if (drift.length === 0) {
    process.stdout.write('reference docs are up to date.\n');
    return 0;
  }
  for (const item of drift) {
    const rel = item.path.slice(ROOT.length + 1);
    process.stderr.write(`drift: ${rel}\n`);
    if (item.onDisk === null) {
      process.stderr.write('  (file is missing — run `pnpm docs:generate`)\n');
    } else {
      process.stderr.write(
        `  on-disk:  ${item.onDisk.length} bytes; generated: ${item.expected.length} bytes\n`,
      );
    }
  }
  process.stderr.write(
    `\n${drift.length} reference doc(s) out of date. Run \`pnpm docs:generate\` and commit the result.\n`,
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`docs runner failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
