// @psraghuveer/memento — executable entry point.
//
// Built with a `#!/usr/bin/env node` banner via tsup so that
// `npx memento` works directly. Everything interesting lives in
// `run.ts`; this file exists only so the bundle has a tiny
// well-defined entry that:
//
//   1. wires the live process to a `CliIO`,
//   2. runs the dispatcher,
//   3. converts any thrown exception (which should be impossible,
//      since `Result` is the contract) into a human-readable
//      message + exit 1 instead of a raw Node stack.
//
// `runCli` always terminates via `io.exit`, so the `await` here
// only returns through the catch path.

import { nodeIO } from './io.js';
import { runCli } from './run.js';

try {
  await runCli(nodeIO());
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`memento: unhandled error: ${message}\n`);
  process.exit(1);
}
