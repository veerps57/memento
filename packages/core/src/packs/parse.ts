// Pack manifest parser.
//
// Reads a UTF-8 string of YAML and returns a parsed
// `PackManifest` along with any forward-compat warnings (unknown
// top-level keys that v1.x additives may legitimately introduce).
// Errors carry the YAML line/column when the underlying YAML
// parser can localise them — surfacing those at the install
// boundary is the difference between "your pack is broken" and
// "your pack is broken at line 17 column 5".
//
// The parser layer is deliberately separate from the schema. The
// schema (`PackManifestSchema`) is `.strict()` so unknown keys
// are visible; the parser detects them, emits a warning, strips
// them before schema validation, and continues. This matches the
// posture in ADR-0013 §schema-version-skew (an importer of an
// older artefact is liberal in what it accepts but loud about
// what it strips).

import {
  PACK_FORMAT_VERSION,
  type PackManifest,
  PackManifestSchema,
} from '@psraghuveer/memento-schema';
import { type Document, parseDocument } from 'yaml';

/**
 * Outcome of parsing a pack manifest. `warnings` is non-empty
 * when the parser stripped one or more unknown top-level keys
 * (forward-compat additives) before schema validation. The
 * caller surfaces them in the install / preview output.
 */
export interface PackParseSuccess {
  readonly ok: true;
  readonly manifest: PackManifest;
  readonly warnings: readonly string[];
}

/**
 * Failure to parse — either YAML syntax error, format-version
 * mismatch, or schema violation. `line` / `column` are populated
 * when the YAML parser could localise the failure.
 */
export interface PackParseFailure {
  readonly ok: false;
  readonly error: string;
  readonly line?: number;
  readonly column?: number;
}

export type PackParseOutcome = PackParseSuccess | PackParseFailure;

/**
 * Top-level keys accepted by `memento-pack/v1`. Used to detect
 * forward-compat additives in v1.x manifests so the parser can
 * warn-and-strip them before schema validation. Keep in lockstep
 * with `PackManifestSchema`.
 */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
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
]);

/**
 * Parses a UTF-8 YAML string into a typed {@link PackManifest}.
 * The parser is forward-compat liberal about unknown top-level
 * keys (warns and strips) but strict about schema shape inside
 * known keys (fails with a structured error).
 */
export function parsePackManifest(raw: string): PackParseOutcome {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(raw, { prettyErrors: true });
  } catch (err) {
    return { ok: false, error: `YAML parse failed: ${(err as Error).message}` };
  }

  if (doc.errors.length > 0) {
    const firstErr = doc.errors[0];
    if (!firstErr) {
      return { ok: false, error: 'YAML parse failed' };
    }
    return {
      ok: false,
      error: firstErr.message,
      ...locFromYamlError(firstErr),
    };
  }

  const rootRaw = doc.toJS();
  if (rootRaw === null || typeof rootRaw !== 'object' || Array.isArray(rootRaw)) {
    return { ok: false, error: 'pack manifest must be a YAML object at the top level' };
  }
  const root = rootRaw as ManifestEnvelope;

  // Refuse a v2 (or otherwise unknown) format up front, before
  // schema validation, so the error names the format mismatch
  // rather than blaming an unrelated field shape.
  if (typeof root.format === 'string' && root.format !== PACK_FORMAT_VERSION) {
    return {
      ok: false,
      error: `unsupported pack format ${JSON.stringify(root.format)}; this build only understands ${JSON.stringify(PACK_FORMAT_VERSION)}`,
    };
  }

  // Detect forward-compat additives. Unknown top-level keys are
  // warned-and-stripped — a v1 reader presented with a v1.x
  // manifest carrying `embeddings:` (a hypothetical future field)
  // continues parsing the v1 fields it knows.
  const warnings: string[] = [];
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) {
      stripped[key] = value;
    } else {
      warnings.push(`unknown top-level key ${JSON.stringify(key)} ignored (forward-compat)`);
    }
  }

  const result = PackManifestSchema.safeParse(stripped);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) {
      return { ok: false, error: 'pack manifest failed validation' };
    }
    const path = issue.path.length > 0 ? `at ${issue.path.join('.')}` : '';
    return { ok: false, error: `${issue.message}${path ? ` (${path})` : ''}` };
  }

  return { ok: true, manifest: result.data, warnings };
}

interface ManifestEnvelope {
  readonly format?: unknown;
  readonly [key: string]: unknown;
}

interface YamlErrorWithLoc {
  readonly linePos?: ReadonlyArray<{ readonly line: number; readonly col: number }>;
}

function locFromYamlError(err: unknown): { line?: number; column?: number } {
  const e = err as YamlErrorWithLoc;
  const start = e.linePos?.[0];
  if (!start) return {};
  return { line: start.line, column: start.col };
}
