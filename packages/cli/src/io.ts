// CliIO — the abstract IO surface the CLI runs against.
//
// Why an interface and not raw `process` access?
//
// `runCli` is the single dispatcher for everything `npx memento`
// can do. We want every code path through it to be exercised
// in-process by the test suite — no spawning a child, no
// snapshotting stdout files, no flaky timing. Threading IO
// through a small typed object makes that trivial: tests pass a
// fake `CliIO` whose `stdout`/`stderr` collect strings into
// arrays and whose `exit` records the requested code rather
// than terminating the process.
//
// The interface is deliberately narrow: only the byte streams,
// argv (already sliced), env, the TTY signal, and `exit`. Adding
// a new IO concern (e.g. clipboard) means widening the contract
// here, not reaching for `process` from a leaf module.

import process from 'node:process';

/**
 * The byte sink any CLI subcommand writes to. Distilled to one
 * synchronous `write` so tests can stub it with a string array
 * without faking the entire `Writable` surface.
 */
export interface CliWritable {
  write(chunk: string): void;
}

export interface CliIO {
  /** Argv with `node` and the script path already stripped. */
  readonly argv: readonly string[];
  /** Environment variables. Read-only by contract. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Standard input; used by subcommands that accept piped JSON. */
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
  /**
   * Whether stdout is a TTY. Used to pick the default output
   * format (`text` for humans, `json` for pipes/scripts).
   */
  readonly isTTY: boolean;
  /**
   * Whether stderr is a TTY. Used to gate human-facing status
   * messages (e.g. the `serve` readiness line) so they appear
   * for an operator running `memento serve` directly but stay
   * silent when the process is launched by an MCP client.
   *
   * stdout cannot carry status output for `serve` because it is
   * the MCP byte transport; stderr is the only safe surface,
   * and it is `process.stderr.isTTY` (not stdout) that tells us
   * whether a human is watching.
   */
  readonly isStderrTTY: boolean;
  /**
   * Terminate the process with the given exit code. Returns
   * `never` so callers can `return io.exit(...)` and TypeScript
   * narrows correctly.
   */
  exit(code: number): never;
}

/**
 * The default `CliIO` bound to the live Node process. Cheap;
 * safe to call once per `npx memento` invocation. Tests should
 * not call this.
 */
export function nodeIO(): CliIO {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin,
    stdout: {
      write(chunk: string): void {
        process.stdout.write(chunk);
      },
    },
    stderr: {
      write(chunk: string): void {
        process.stderr.write(chunk);
      },
    },
    isTTY: Boolean(process.stdout.isTTY),
    isStderrTTY: Boolean(process.stderr.isTTY),
    exit(code: number): never {
      return process.exit(code);
    },
  };
}
