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
      // Crash class we are working around: when both `better-sqlite3`
      // and `onnxruntime-node` (loaded transitively by the local
      // embedder) are alive in the same Node process, the natural
      // exit sequence deterministically aborts with `libc++abi:
      // terminating due to uncaught exception of type
      // std::__1::system_error: mutex lock failed: Invalid argument`.
      // The two native modules' destructors race on a shared mutex
      // at process teardown. We verified empirically that:
      //   - `process.exit(code)` triggers the race.
      //   - `process.reallyExit(code)` (Node's internal equivalent
      //     of `_exit(2)`) also triggers it — C++ destructors run
      //     in both paths.
      //   - `pipeline.dispose()` on the transformers.js extractor
      //     (ADR-0025) does not release the threads in time.
      //   - `intraOpNumThreads: 1` does not help.
      //   - Self-`SIGKILL` bypasses every destructor cleanly.
      //
      // The hatch: when the embedder was loaded in this process
      // (signalled by the `__memento_embedder_loaded` global the
      // embedder-local package sets on first init), self-SIGKILL
      // after draining stdio. The cost is that the OS-level exit
      // code becomes 137 (128 + SIGKILL=9), losing the JS-level
      // intended code. We accept this because the commands that
      // actually load the embedder (`dashboard`, `serve`, `pack
      // install`, `import`) are either interactive (the user reads
      // stdout, not the exit code) or already produce a structured
      // result envelope on stdout that callers can parse.
      //
      // For commands that never loaded the embedder (most short
      // commands when warmup hasn't completed), there is no race
      // and `process.exit` is safe + preserves the exit code.
      //
      // See ADR-0026 for the full rationale and the worker-thread
      // refactor we intend as the proper long-term fix.
      const embedderLoaded =
        (globalThis as { __memento_embedder_loaded?: boolean }).__memento_embedder_loaded === true;
      if (!embedderLoaded) {
        return process.exit(code);
      }
      const kill = (): never => process.kill(process.pid, 'SIGKILL') as never;
      // Drain stdout/stderr so piped output (CI scripts, `jq`
      // pipelines on the JSON result snapshot, redirected stderr
      // logs) is not truncated. `write('', cb)` resolves once the
      // stream has drained any pending buffered writes — for TTYs
      // this is effectively immediate; for piped consumers it can
      // take a tick.
      let stdoutDone = false;
      let stderrDone = false;
      const maybeExit = (): void => {
        if (stdoutDone && stderrDone) kill();
      };
      process.stdout.write('', () => {
        stdoutDone = true;
        maybeExit();
      });
      process.stderr.write('', () => {
        stderrDone = true;
        maybeExit();
      });
      // Belt-and-suspenders: if either drain callback never fires
      // (closed pipe on the consumer end, broken stdio), SIGKILL
      // anyway on the next tick so the process cannot hang on
      // busted stdio.
      setImmediate(kill);
      return undefined as never;
    },
  };
}
