// `memento explain <code>` — look up an error code and print
// its meaning + remediation.
//
// The full catalogue lives in `docs/reference/error-codes.md`,
// auto-generated from `MementoError.code`. Keeping a parallel
// in-CLI table would be a maintenance hazard, so this command
// reads the doc at runtime. The doc is shipped inside the npm
// tarball (see `files` in package.json), so it's always
// available where the CLI is.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Result, err, ok } from '@psraghuveer/memento-schema';

import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Stable contract for `memento explain`. */
export interface ExplainSnapshot {
  readonly code: string;
  readonly summary: string;
  readonly body: string;
}

export const explainCommand: LifecycleCommand = {
  name: 'explain',
  description: 'Print the catalogued meaning of an error code (e.g. STORAGE_ERROR)',
  run: runExplain,
};

export async function runExplain(
  _deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<ExplainSnapshot>> {
  if (input.subargs.length === 0) {
    return err({
      code: 'INVALID_INPUT',
      message: 'explain requires an error code (e.g. `memento explain STORAGE_ERROR`)',
    });
  }
  const codeRaw = input.subargs[0] as string;
  const code = codeRaw.toUpperCase();

  const doc = await loadCatalogue();
  if (doc === undefined) {
    return err({
      code: 'INTERNAL',
      message:
        'error-codes.md not found in the installed package; reinstall @psraghuveer/memento to restore docs',
    });
  }
  const section = extractSection(doc, code);
  if (section === undefined) {
    return err({
      code: 'INVALID_INPUT',
      message: `unknown error code '${code}'. See \`memento doctor\` or docs/reference/error-codes.md for the full catalogue.`,
    });
  }
  return ok({ code, summary: section.summary, body: section.body });
}

async function loadCatalogue(): Promise<string | undefined> {
  // Search a small set of plausible install layouts. The first
  // match wins; the order matches the tarball layout (docs at
  // top of the package), then an in-monorepo dev layout.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'docs', 'reference', 'error-codes.md'),
    path.join(here, '..', '..', '..', 'docs', 'reference', 'error-codes.md'),
    path.join(here, '..', '..', '..', '..', 'docs', 'reference', 'error-codes.md'),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // try next
    }
  }
  return undefined;
}

interface CatalogueSection {
  readonly summary: string;
  readonly body: string;
}

/**
 * Extract a single error code's section from the markdown
 * catalogue. Sections are delimited by `## CODE` headings; we
 * lift everything up to the next H2 (or end-of-file).
 */
function extractSection(doc: string, code: string): CatalogueSection | undefined {
  const lines = doc.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === `## ${code}` || line.trim() === `## \`${code}\``) {
      start = i;
      break;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if ((lines[i] as string).startsWith('## ')) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  // Summary is the first non-empty paragraph.
  const summary = body.split(/\n\s*\n/u)[0]?.trim() ?? '';
  return { summary, body };
}
