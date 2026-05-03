import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite config for the dashboard SPA.
 *
 * Build output goes to `dist-ui/` (sibling to `dist/`, which is
 * tsup's server-bundle output). Both directories ship in the npm
 * tarball; the lifecycle command resolves the UI dir at runtime
 * with `resolveDashboardUiDir()`.
 *
 * The dev server (`pnpm dev`) runs on a default Vite port and
 * proxies API calls to the dashboard server during development.
 * In production, the dashboard server itself serves the static
 * bundle, so no proxy is involved.
 */
export default defineConfig({
  root: path.resolve(here, '.'),
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(here, 'src/ui'),
    },
  },
  build: {
    outDir: path.resolve(here, 'dist-ui'),
    emptyOutDir: true,
    // Sourcemaps are off for the shipped build. The static
    // handler in `src/server/index.ts` serves the bundle
    // directory, so any `.map` file emitted next to the JS
    // would be reachable by anyone who could reach the
    // dashboard URL — a detailed map of routes, API call
    // sites, and internal helpers. Set to `'hidden'` if you
    // need maps locally for crash-report tooling without
    // serving them.
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Forward API calls to the dashboard server when running
      // `pnpm dev`. Requires the dashboard server to be running
      // separately on 4747 (e.g. via `memento dashboard` against
      // a dev DB). For full-stack dev there's a `dev:full`
      // script you can add later.
      '/api': {
        target: 'http://127.0.0.1:4747',
        changeOrigin: false,
      },
    },
  },
});
