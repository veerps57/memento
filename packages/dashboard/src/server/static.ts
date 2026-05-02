// Resolve where the built UI bundle lives on the running install.
//
// The CLI build's `vite build` step produces a static SPA bundle
// at `<package>/dist-ui/`. The Hono server serves files from that
// directory at the root path. This helper walks up from the
// running module to find it, returning `null` when the bundle is
// not present (e.g. the dashboard package has been installed but
// `pnpm build` has never run).
//
// `null` is a first-class signal: the lifecycle command and the
// server middleware treat it as "fall back to a friendly 'run
// pnpm build' page" rather than crashing the static handler.
//
// Mirrors the resolver pattern in `packages/cli/src/skill-source.ts`
// — same probe-multiple-depths idea so the function works from
// both the bundled `dist/index.js` and a source-tree import in
// tests.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the built UI bundle directory, or `null` if
 * the bundle is not present.
 *
 * @param originDir Override for the search origin. Defaults to
 *   the directory containing this module file (the production
 *   call path). Tests pass a tmp directory.
 */
export function resolveDashboardUiDir(originDir?: string): string | null {
  const here = originDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 1; depth <= 4; depth += 1) {
    const ascent = Array.from({ length: depth }, () => '..');
    const candidate = path.resolve(here, ...ascent, 'dist-ui');
    if (existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}
