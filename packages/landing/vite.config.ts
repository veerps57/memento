import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Build-time `dateModified` for the landing page. Sourced from
 * the most recent commit touching `packages/landing/` so the
 * timestamp survives unrelated commits and reflects actual
 * content changes. Injected into both the visible footer (via
 * `__MEMENTO_LAST_MODIFIED_HUMAN__`) and the JSON-LD graph (via
 * `__MEMENTO_LAST_MODIFIED_ISO__`). Falls back to "now" only on
 * the first commit or in shallow checkouts where git log is
 * empty — in dev mode this is harmless; in CI the checkout
 * always has the relevant history.
 */
function lastModifiedISO(): string {
  try {
    const out = execSync('git log -1 --format=%cI -- packages/landing', {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    return out !== '' ? out : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

const lastModifiedIso = lastModifiedISO();
const lastModifiedHuman = new Date(lastModifiedIso).toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/**
 * Vite config for the marketing landing page.
 *
 * `base` is driven by an env var so the same build pipeline
 * stays flexible. Production serves at the apex of
 * `runmemento.com`, so the default is `/`. Override with
 * `VITE_BASE_PATH=/some-prefix/` if a future deploy target
 * lives under a path.
 */
export default defineConfig({
  root: path.resolve(here, '.'),
  base: process.env.VITE_BASE_PATH ?? '/',
  publicDir: path.resolve(here, 'public'),
  plugins: [react()],
  define: {
    __MEMENTO_LAST_MODIFIED_ISO__: JSON.stringify(lastModifiedIso),
    __MEMENTO_LAST_MODIFIED_HUMAN__: JSON.stringify(lastModifiedHuman),
  },
  build: {
    outDir: path.resolve(here, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
