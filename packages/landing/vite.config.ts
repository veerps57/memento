import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite config for the marketing landing page.
 *
 * `base` is driven by an env var so the same build pipeline
 * works for two deploy targets:
 *
 *   - GitHub Pages at `https://<user>.github.io/memento/` →
 *     `VITE_BASE_PATH=/memento/` (the default).
 *   - Custom domain at the apex (e.g. `memento.dev`) →
 *     `VITE_BASE_PATH=/`.
 *
 * The deploy workflow sets the env var; locally `pnpm dev`
 * just uses the default.
 */
export default defineConfig({
  root: path.resolve(here, '.'),
  base: process.env.VITE_BASE_PATH ?? '/memento/',
  publicDir: path.resolve(here, 'public'),
  plugins: [react()],
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
