#!/usr/bin/env node
// Pack YAML formatter — keeps every `packs/<id>/v<version>.yaml`
// in a canonical shape so contributors don't drift on key order,
// scalar style, indentation, or final-newline policy.
//
// What's enforced:
//
//   1. Top-level key order:
//      format, id, version, title, description, author, license,
//      homepage, tags, defaults, memories
//   2. Per-memory key order:
//      kind, content, summary, rationale, due, language, tags,
//      pinned, sensitive
//   3. Block-style scalars (`|`) for multi-line content (default
//      via `blockQuote: 'literal'` on the `yaml` package).
//   4. 2-space indentation.
//   5. No automatic line-wrapping (`lineWidth: 0`); long lines stay
//      as authored — the input has already made the readability
//      decision.
//   6. Single trailing newline.
//   7. Leading comment block (e.g. the `# yaml-language-server:
//      $schema=…` header) is preserved verbatim above the body
//      and separated from it by one blank line.
//   8. Blank line between each top-level memory entry, for
//      scannability — added during canonicalisation rather than
//      relying on author discipline.
//
// Modes:
//   --write   (default) — rewrite drifted files in place.
//   --check             — print drift, exit non-zero. CI uses this.
//
// Why a custom script: biome's YAML support is preview-grade and
// has no semantic awareness (no enforced key order). Using the
// same `yaml` package the engine already depends on (consumed by
// `pack.export` via `buildManifestFromMemories`) keeps the
// toolchain narrow and the canonical form deterministic.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, stringify } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = resolve(ROOT, 'packs');

const PACK_KEY_ORDER = [
  'format',
  'id',
  'version',
  'title',
  'description',
  'author',
  'license',
  'homepage',
  'tags',
  'defaults',
  'memories',
];

const ITEM_KEY_ORDER = [
  'kind',
  'content',
  'summary',
  'rationale',
  'due',
  'language',
  'tags',
  'pinned',
  'sensitive',
];

const STRINGIFY_OPTS = {
  blockQuote: 'literal',
  lineWidth: 0,
};

/**
 * Discover every `packs/<id>/v<version>.yaml`. Returns absolute
 * paths. Empty when `packs/` is absent.
 */
async function discoverPackFiles() {
  let dirs;
  try {
    dirs = await readdir(PACKS_DIR);
  } catch {
    return [];
  }
  const files = [];
  for (const id of dirs) {
    const dir = resolve(PACKS_DIR, id);
    let isDir;
    try {
      isDir = (await stat(dir)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const entries = await readdir(dir);
    for (const file of entries) {
      if (!/^v.+\.yaml$/.test(file)) continue;
      files.push(resolve(dir, file));
    }
  }
  return files.sort();
}

/**
 * Splits the leading comment block (lines starting with `#` plus
 * any blank lines mixed in) from the YAML body. The comment block
 * is preserved verbatim across formatting; the body is canonicalised.
 */
function splitHeader(raw) {
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('#') || line.trim() === '') {
      i += 1;
      continue;
    }
    break;
  }
  // Header includes leading comments only; if everything was
  // blank+comments we still treat the whole thing as a header
  // (unlikely in practice).
  const headerLines = lines.slice(0, i).filter((l) => l.startsWith('#'));
  const body = lines.slice(i).join('\n');
  return { header: headerLines.join('\n'), body };
}

/**
 * Returns a new object with the supplied keys in `order` first
 * (those that exist on `obj`), then any unknown keys at the end.
 * Unknown keys land at the bottom so a forward-compat manifest
 * field added in v1.x lands last and is visible.
 */
function reorderKeys(obj, order) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const key of order) {
    if (key in obj) out[key] = obj[key];
  }
  for (const key of Object.keys(obj)) {
    if (!order.includes(key)) out[key] = obj[key];
  }
  return out;
}

function canonicaliseManifest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('manifest must be a YAML mapping at the top level');
  }
  const ordered = reorderKeys(input, PACK_KEY_ORDER);
  if (Array.isArray(ordered.memories)) {
    ordered.memories = ordered.memories.map((item) =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? reorderKeys(item, ITEM_KEY_ORDER)
        : item,
    );
  }
  return ordered;
}

/**
 * Inserts a single blank line between top-level memory entries so
 * the file is scannable. The `yaml` package emits adjacent list
 * items without spacing; we re-add it as a post-processing pass
 * that's deterministic given the input shape.
 */
function blankLineBetweenMemories(yamlText) {
  // Split lines. Inside `memories:`, each entry begins with
  // `  - ` at the start of a line. Insert a blank line above each
  // such entry except the first.
  const lines = yamlText.split('\n');
  const out = [];
  let inMemories = false;
  let firstEntryConsumed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === 'memories:') {
      inMemories = true;
      firstEntryConsumed = false;
      out.push(line);
      continue;
    }
    // Top-level key resets the marker.
    if (inMemories && /^[a-z]/.test(line)) {
      inMemories = false;
    }
    if (inMemories && line.startsWith('  - ')) {
      if (firstEntryConsumed && out[out.length - 1] !== '') {
        out.push('');
      }
      firstEntryConsumed = true;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Canonicalise one pack YAML. Pure: input string → canonical
 * output string. Exported so the unit test can pin the
 * canonicalisation rules without re-implementing them.
 */
export function format(raw) {
  const { header, body } = splitHeader(raw);
  const parsed = parse(body);
  const canonical = canonicaliseManifest(parsed);
  const stringified = stringify(canonical, STRINGIFY_OPTS);
  const spaced = blankLineBetweenMemories(stringified);
  let output = spaced;
  if (header.length > 0) {
    output = `${header}\n\n${output}`;
  }
  if (!output.endsWith('\n')) output += '\n';
  return output;
}

export { PACK_KEY_ORDER, ITEM_KEY_ORDER };

async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const isWrite = args.includes('--write') || (!isCheck && args.length === 0);
  if (isCheck && isWrite) {
    process.stderr.write('format-packs: cannot pass both --check and --write\n');
    process.exit(2);
  }
  if (!isCheck && !isWrite) {
    process.stderr.write(`format-packs: unknown flag(s): ${args.join(' ')}\n`);
    process.exit(2);
  }

  const files = await discoverPackFiles();
  if (files.length === 0) {
    process.stdout.write('format-packs: no pack YAMLs found under packs/.\n');
    return 0;
  }

  const drifted = [];
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    let canonical;
    try {
      canonical = format(raw);
    } catch (cause) {
      const rel = file.slice(ROOT.length + 1);
      process.stderr.write(`format-packs: ${rel}: ${cause.message}\n`);
      return 1;
    }
    if (raw === canonical) continue;
    if (isCheck) {
      drifted.push(file);
    } else {
      await writeFile(file, canonical, 'utf8');
      const rel = file.slice(ROOT.length + 1);
      process.stdout.write(`formatted ${rel}\n`);
    }
  }

  if (isCheck && drifted.length > 0) {
    process.stderr.write(`pack format drift in ${drifted.length} file(s):\n`);
    for (const file of drifted) {
      process.stderr.write(`  ${file.slice(ROOT.length + 1)}\n`);
    }
    process.stderr.write('run `pnpm format:packs` to fix.\n');
    return 1;
  }

  if (isWrite && drifted.length === 0 && files.length > 0) {
    // No change — print a quiet success line so CI logs aren't
    // ambiguous about whether the script ran.
    process.stdout.write(`format-packs: ${files.length} file(s) already canonical.\n`);
  }

  return 0;
}

// Run as CLI only when invoked directly (`node scripts/format-packs.mjs`).
// When imported by a test, the script's exports are consumed
// without firing the CLI side-effects.
const invokedAsCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedAsCli) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`format-packs: ${error?.stack ?? error}\n`);
      process.exit(1);
    });
}
