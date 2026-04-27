import { createConfig } from '../../tsup.config.base';

export default createConfig({
  // Two entries:
  //   index.ts — programmatic API (rare; mostly for tests)
  //   cli.ts   — the executable that npx memento launches
  entry: ['src/index.ts', 'src/cli.ts'],
  banner: {
    // The shebang must appear at the very top of the bundled CLI
    // so that the file is directly executable on POSIX systems
    // when installed via npm/npx.
    js: '#!/usr/bin/env node',
  },
});
