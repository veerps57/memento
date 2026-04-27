import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the end-to-end suite.
 *
 * The E2E tests spawn the *built* `memento` CLI as a child
 * process and drive it over MCP-stdio. They require
 * `pnpm build` to have produced `packages/cli/dist/cli.js`
 * (and the dependency packages' dist outputs) before the
 * suite runs — `pnpm test:e2e` chains the build for you.
 *
 * The split from `vitest.config.ts` (which excludes
 * `*.e2e.test.ts`) keeps the inner-loop `pnpm test` fast:
 * unit tests stay in-process and avoid the cost of spawning
 * Node + opening a SQLite file per test. CI runs both
 * suites; `pnpm verify` chains them locally.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false,
    isolate: true,

    // E2E tests spawn a child process and exchange JSON-RPC
    // messages over stdio. The default 10s timeout is tight
    // for a cold-start MCP handshake on slower CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
