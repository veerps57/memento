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

import { zodToJsonSchema } from 'zod-to-json-schema';

import { LIFECYCLE_COMMANDS } from '../packages/cli/dist/index.js';
import {
  createMementoApp,
  renderCliDoc,
  renderConfigKeysDoc,
  renderErrorCodesDoc,
  renderMcpToolsDoc,
} from '../packages/core/dist/index.js';
import {
  CONFIG_KEYS,
  PACK_FORMAT_VERSION,
  PackManifestSchema,
} from '../packages/schema/dist/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_DIR = resolve(ROOT, 'docs/reference');
const LANDING_PUBLIC_SCHEMAS = resolve(ROOT, 'packages/landing/public/schemas');

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
      // The JSON Schema for `memento-pack/v1` is shipped in two
      // places, deliberately. The repo copy at `docs/reference/`
      // is what `docs:check` validates against and what
      // contributors-in-repo can reference via a relative path.
      // The landing copy at `packages/landing/public/schemas/`
      // gets deployed to `https://runmemento.com/schemas/` so
      // anyone authoring a pack outside the repo can wire their
      // editor to the public URL. Both files have identical
      // content; `docs:check` keeps them in lockstep.
      {
        path: resolve(REFERENCE_DIR, 'pack-schema.json'),
        content: renderPackJsonSchema(),
      },
      {
        path: resolve(LANDING_PUBLIC_SCHEMAS, 'memento-pack-v1.json'),
        content: renderPackJsonSchema(),
      },
    ];
  } finally {
    app.close();
  }
}

/**
 * Renders `PackManifestSchema` (Zod) as a JSON Schema document
 * suitable for editor language-server validation. Bundled packs
 * carry a `# yaml-language-server: $schema=…` header pointing to
 * the published location of this file so contributors get
 * inline validation as they type.
 *
 * `$refStrategy: 'none'` inlines every sub-definition so the
 * resulting schema is self-contained — no `#/definitions/Tag`
 * indirections that an external tool would have to resolve.
 *
 * The trailing newline keeps `pnpm docs:check`'s on-disk vs
 * generated comparison stable across editors that auto-add one.
 */
function renderPackJsonSchema() {
  const schema = zodToJsonSchema(PackManifestSchema, {
    name: 'MementoPackManifest',
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });
  // Top-level fields beyond `name`/`definitions`/`$schema` provide
  // a stable description and the format version this schema
  // covers. Editors surface these in tooltips.
  schema.title = `Memento Pack Manifest (${PACK_FORMAT_VERSION})`;
  schema.description = `JSON Schema for the \`${PACK_FORMAT_VERSION}\` pack format. Generated from \`PackManifestSchema\` (packages/schema/src/pack.ts) via \`pnpm docs:generate\`. Do not edit by hand.`;
  return `${JSON.stringify(schema, null, 2)}\n`;
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
