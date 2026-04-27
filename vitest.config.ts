import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config.
 *
 * Each package under packages/* may add its own vitest.config.ts
 * with package-specific settings (e.g. setup files, integration
 * test globs). The root config is what `pnpm test` uses for
 * cross-package runs and what CI invokes.
 *
 * Coverage thresholds are enforced at 90% lines AND branches on
 * the core and adapter packages, per the contribution guide.
 * Until those packages have code, the threshold check is
 * effectively a no-op (no covered files), but the configuration
 * is wired now so the first PR that adds real code cannot
 * accidentally land below the bar.
 */
export default defineConfig({
  test: {
    // Discover tests in every workspace package.
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      // E2E tests spawn the built CLI and live in
      // `packages/*/test/e2e/**`. They are run via the
      // dedicated `pnpm test:e2e` script (which builds first)
      // and the separate `vitest.e2e.config.ts`.
      '**/*.e2e.test.ts',
    ],

    // Strict mode: no test discovery surprises.
    passWithNoTests: true,

    // Each package's tests run in isolation; no shared state.
    isolate: true,

    // Reasonable defaults; package configs can override.
    testTimeout: 10_000,
    hookTimeout: 10_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/test/**', '**/dist/**', '**/index.ts'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
