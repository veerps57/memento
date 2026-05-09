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

import { execSync } from 'node:child_process';
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
  CONFIG_KEY_NAMES,
  CONFLICT_EVENT_TYPES,
  MEMORY_EVENT_TYPES,
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

// =============================================================
// Verify-chain marker substitution
// =============================================================
//
// `pnpm verify` is the single source of truth for the pre-PR
// verification chain. The chain text appears in four contributor-
// facing docs (AGENTS.md, CONTRIBUTING.md, copilot-instructions,
// PR template). Hand-maintaining four copies drifts; instead, the
// docs declare a marker block and this generator fills it in.
//
//   <!-- verify-chain:begin -->lint → typecheck → ...<!-- verify-chain:end -->
//
// `--write` rewrites the marker block. `--check` diffs the marker
// block against the live `package.json` and fails on drift.

const VERIFY_CHAIN_MARKER_BEGIN = '<!-- verify-chain:begin -->';
const VERIFY_CHAIN_MARKER_END = '<!-- verify-chain:end -->';

const VERIFY_CHAIN_FILES = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.github/copilot-instructions.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
];

async function buildVerifyChainText() {
  const pkgPath = resolve(ROOT, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const script = pkg?.scripts?.verify;
  if (typeof script !== 'string') {
    throw new Error('package.json has no `verify` script to derive the chain from');
  }
  const steps = script
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((step) => {
      const m = step.match(/^pnpm\s+([\w:-]+)$/);
      if (!m) throw new Error(`unexpected verify-chain step: ${JSON.stringify(step)}`);
      return m[1];
    });
  return steps.join(' → ');
}

function applyVerifyChain(content, chainText) {
  const begin = VERIFY_CHAIN_MARKER_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const end = VERIFY_CHAIN_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${begin}[\\s\\S]*?${end}`, 'g');
  return content.replace(re, `${VERIFY_CHAIN_MARKER_BEGIN}${chainText}${VERIFY_CHAIN_MARKER_END}`);
}

async function buildVerifyChainDocs(chainText) {
  const out = [];
  for (const file of VERIFY_CHAIN_FILES) {
    const path = resolve(ROOT, file);
    const before = await readExisting(path);
    if (before === null) {
      throw new Error(`verify-chain consumer missing: ${file}`);
    }
    if (!before.includes(VERIFY_CHAIN_MARKER_BEGIN)) {
      throw new Error(
        `verify-chain consumer ${file} is missing the \`${VERIFY_CHAIN_MARKER_BEGIN}\` marker. Add the marker pair where the chain text should appear.`,
      );
    }
    out.push({ path, content: applyVerifyChain(before, chainText) });
  }
  return out;
}

// =============================================================
// Phantom config-key / command-name scan
// =============================================================
//
// Walks every .md file in the workspace. Extracts identifiers of
// the form `<known-namespace>.<rest>` (where `<known-namespace>`
// is a top-level config-key namespace or a registered command
// namespace). Verifies each literal is a registered config key,
// a registered command name, contains a meta-token (`<kind>` etc.),
// or matches the small allowlist of structural false positives
// (`import.meta`).
//
// Files carrying `<!-- phantom-keys: ignore-file -->` are skipped.
// That is the escape hatch for genuinely-illustrative content
// (rare); use it sparingly.

const PHANTOM_OPT_OUT_MARKER = '<!-- phantom-keys: ignore-file -->';

// Exact-match allowlist for structural false positives that
// happen to share the dotted shape of a Memento identifier.
const PHANTOM_EXACT_ALLOWLIST = new Set([
  'import.meta', // TypeScript / ESM
]);

// File-extension tail segments: matches like `retrieval.md` or
// `config.ts` are markdown link paths, not config-key references.
const FILE_EXTENSION_TAILS = new Set([
  'md',
  'mdx',
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'json',
  'yaml',
  'yml',
  'html',
  'css',
  'png',
  'jpg',
  'jpeg',
  'svg',
  'gif',
  'sh',
  'bash',
  'zsh',
  'sql',
  'toml',
  'ini',
  'env',
  'lock',
  'log',
]);

function listMarkdownFiles() {
  const out = execSync(
    'find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/coverage/*" -not -path "*/.git/*" -not -name "CHANGELOG.md"',
    { cwd: ROOT, encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ''));
}

// ADRs document decisions, including alternatives that were
// rejected and proposals that pre-date their final shape. By
// definition they reference identifiers that may not exist in the
// shipping registry — that is the genre. The link-check still
// gates ADR cross-refs; the phantom-key check skips them so the
// signal stays clean for prose docs.
const PHANTOM_SKIP_PREFIXES = ['docs/adr/'];

function shouldSkipForPhantomCheck(file) {
  return PHANTOM_SKIP_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function isLegitimateReference(literal, validIdentifiers) {
  if (PHANTOM_EXACT_ALLOWLIST.has(literal)) return true;
  if (/<\w+>/.test(literal)) return true; // meta-token; schema talk

  // File-path / asset paths inside markdown links, e.g.
  // `retrieval.md`, `config.ts`, `og.png`. The trailing segment
  // gives them away.
  const segments = literal.split('.');
  const tail = segments[segments.length - 1].toLowerCase();
  if (FILE_EXTENSION_TAILS.has(tail)) return true;

  // Exact match against a registered identifier (config key,
  // command, or known event type).
  if (validIdentifiers.has(literal)) return true;

  // Any registered prefix is enough — e.g. `system.info.counts`
  // is legitimate prose because `system.info` is a registered
  // command and `counts` is one of its output fields.
  for (let n = segments.length - 1; n >= 1; n--) {
    const prefix = segments.slice(0, n).join('.');
    if (validIdentifiers.has(prefix)) return true;
  }

  // The literal is itself a namespace prefix of a registered
  // identifier — e.g. `embedder.local` (no exact match, but
  // `embedder.local.model` exists).
  const literalDot = `${literal}.`;
  for (const id of validIdentifiers) {
    if (id.startsWith(literalDot)) return true;
  }

  return false;
}

async function findPhantomReferences(commands) {
  const validIdentifiers = new Set();
  for (const name of CONFIG_KEY_NAMES) validIdentifiers.add(name);
  for (const command of commands) validIdentifiers.add(command.name);
  // Memory and conflict event types: prose commonly refers to
  // `memory.imported`, `memory.created`, `conflict.resolved`, etc.
  // as event-type discriminators.
  for (const type of MEMORY_EVENT_TYPES) validIdentifiers.add(`memory.${type}`);
  for (const type of CONFLICT_EVENT_TYPES) validIdentifiers.add(`conflict.${type}`);

  const knownNamespaces = new Set();
  for (const id of validIdentifiers) {
    knownNamespaces.add(id.split('.', 1)[0]);
  }
  // First segment is the literal namespace; subsequent segments
  // accept `<` so meta tokens like `<kind>` are captured intact
  // and filtered by the meta-check.
  const nsAlt = [...knownNamespaces]
    .map((ns) => ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`\\b(${nsAlt})\\.[A-Za-z_][\\w]*(?:\\.[A-Za-z_<][\\w<>]*)*`, 'g');

  const files = listMarkdownFiles();
  const findings = [];
  for (const file of files) {
    if (shouldSkipForPhantomCheck(file)) continue;
    const content = await readFile(resolve(ROOT, file), 'utf8');
    if (content.includes(PHANTOM_OPT_OUT_MARKER)) continue;
    re.lastIndex = 0;
    for (let match = re.exec(content); match !== null; match = re.exec(content)) {
      const literal = match[0];
      if (isLegitimateReference(literal, validIdentifiers)) continue;
      findings.push({
        file,
        literal,
        line: content.slice(0, match.index).split('\n').length,
      });
    }
  }
  return findings;
}

// =============================================================
// Main
// =============================================================

async function main() {
  const mode = parseMode(process.argv);
  const docs = await buildDocs();

  // The verify-chain consumers are markdown files maintained in-
  // tree; their canonical content is derived from package.json.
  const chainText = await buildVerifyChainText();
  const chainDocs = await buildVerifyChainDocs(chainText);

  // Phantom references need a built registry; reuse the same in-
  // memory app the reference docs already opened.
  const app = await createMementoApp({ dbPath: ':memory:' });
  let phantoms;
  try {
    phantoms = await findPhantomReferences(app.registry.list());
  } finally {
    app.close();
  }

  const allDocs = [...docs, ...chainDocs];

  if (mode === MODE_WRITE) {
    for (const doc of allDocs) {
      await writeFile(doc.path, doc.content, 'utf8');
      const rel = doc.path.slice(ROOT.length + 1);
      process.stdout.write(`wrote ${rel}\n`);
    }
    if (phantoms.length > 0) {
      reportPhantoms(phantoms);
      return 1;
    }
    return 0;
  }

  // --check
  const drift = [];
  for (const doc of allDocs) {
    const onDisk = await readExisting(doc.path);
    if (onDisk !== doc.content) {
      drift.push({ path: doc.path, onDisk, expected: doc.content });
    }
  }

  let exitCode = 0;
  if (drift.length === 0 && phantoms.length === 0) {
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
  if (drift.length > 0) {
    process.stderr.write(
      `\n${drift.length} doc(s) out of date. Run \`pnpm docs:generate\` and commit the result.\n`,
    );
    exitCode = 1;
  }
  if (phantoms.length > 0) {
    reportPhantoms(phantoms);
    exitCode = 1;
  }
  return exitCode;
}

function reportPhantoms(phantoms) {
  process.stderr.write(`\n${phantoms.length} phantom config-key / command reference(s) found:\n`);
  for (const p of phantoms) {
    process.stderr.write(`  ${p.file}:${p.line} → ${p.literal}\n`);
  }
  process.stderr.write(
    '\nThese identifiers look like Memento config keys or commands but are not registered. Either fix the reference, or add `<!-- phantom-keys: ignore-file -->` to the file if the content is genuinely illustrative.\n',
  );
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`docs runner failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
