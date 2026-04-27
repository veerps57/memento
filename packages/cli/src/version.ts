// Resolve the CLI's version from `package.json`.
//
// The version string is part of the user-facing contract
// (`memento --version`). We read it from the package manifest
// at runtime rather than baking it in via tsup `define` because:
//
//  1. It survives `tsup --watch` without rebuild churn.
//  2. The bundle output sits in `dist/` next to `package.json`,
//     so the path is stable and the read is one syscall.
//  3. Falling back to `'0.0.0'` keeps `memento --version` from
//     ever throwing if someone strips `package.json`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_VERSION = '0.0.0';

export function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // From `dist/cli.js` or `src/version.ts`, `package.json`
    // sits one directory up.
    const manifestPath = join(here, '..', 'package.json');
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
