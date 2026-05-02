import { type Options, defineConfig } from 'tsup';

/**
 * Shared tsup configuration for every package in the workspace.
 *
 * Every package's tsup.config.ts should be:
 *
 *   import { createConfig } from '../../tsup.config.base';
 *   export default createConfig({ entry: ['src/index.ts'] });
 *
 * Per-package overrides (extra entries, banners for CLI shebangs,
 * a different format) are merged on top.
 */
export function createConfig(overrides: Options = {}): ReturnType<typeof defineConfig> {
  return defineConfig({
    // Pure ESM. Memento is Node 22+ only and ESM-only.
    format: ['esm'],

    // Emit type declarations as part of the build.
    //
    // `composite: false` disables TypeScript's project-references mode
    // for the internal DTS program. Without this, tsup's DTS worker
    // emits TS6307 ("File is not listed within the file list of
    // project '...'") for any file reached transitively through
    // re-exports — composite projects require every file to be in the
    // explicit `files` list, but tsup's DTS program only seeds itself
    // from the entry points.
    dts: {
      compilerOptions: {
        composite: false,
        incremental: false,
      },
    },

    // Single output directory per package.
    outDir: 'dist',

    // Clean dist before each build so stale files don't linger.
    clean: true,

    // tsup uses tsconfig.json to discover the strict TS options.
    target: 'node22',
    platform: 'node',

    // Source maps for debugging in production stack traces.
    sourcemap: true,

    // No bundling of node_modules; downstream consumers resolve
    // their own copies. Keeps published tarballs small and avoids
    // accidental dual-bundle bugs (e.g. two copies of zod).
    skipNodeModulesBundle: true,

    // Strip dead code with esbuild's tree-shaker but do not minify
    // identifiers — published library code should be readable in
    // stack traces.
    treeshake: true,
    minify: false,

    // tsup will read the package.json to figure out which deps to
    // externalize; this is the recommended setting.
    external: [],

    ...overrides,
  });
}

export default createConfig();
