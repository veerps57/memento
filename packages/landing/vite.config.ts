import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

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
