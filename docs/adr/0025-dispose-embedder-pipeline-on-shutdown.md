# ADR-0025: Bypass the native-module destructor race on process exit

- **Status:** Accepted (supersedes [ADR-0024](0024-generalize-graceful-shutdown.md))
- **Date:** 2026-05-15
- **Deciders:** Memento Authors
- **Tags:** lifecycle, embedding, reliability, native-handles, exit-code

## Context

[ADR-0024](0024-generalize-graceful-shutdown.md) generalised graceful shutdown to drain every fire-and-forget background task — post-write hooks, auto-embed, startup backfill, embedder warmup — before closing the database. We believed this closed the `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument` abort on Ctrl-C of `memento dashboard`.

It didn't. A user upgraded to v0.7.2 (the ADR-0024 release) against an empty store and **still hit the crash**. The success JSON snapshot printed cleanly — meaning `app.shutdown()` ran to completion — and then the process aborted during native-module teardown anyway.

Worse, a focused bisection found the crash class is **universal** across commands that load the embedder, not just `memento dashboard`. Direct empirical evidence on macOS / Node 22 / better-sqlite3 12 / onnxruntime-node 1.21 / @huggingface/transformers 3.8:

| Command | Pre-fix exit | Behaviour |
|---|---|---|
| `memento dashboard` (Ctrl-C) | **134** | Snapshot prints. libc++abi after. |
| `memento status` | **134** | JSON prints. libc++abi after. |
| `memento memory list` | **134** | JSON prints. libc++abi after. |
| `memento --help` | **0** | No embedder loaded. Clean. |

Every command that opens a `MementoApp` triggers the local-embedder warmup (fire-and-forget per ADR-0021). The warmup loads the ONNX feature-extraction pipeline. By the time the command's work finishes, `onnxruntime-node` and `better-sqlite3` are both alive in the process. At natural exit, their destructors race on a shared `std::mutex` and libc++ aborts.

What ADR-0024 got wrong was the framing. The promise we awaited (the embed call) wasn't the threading source — ONNX spins up its thread pool when the **pipeline is created**, regardless of whether anything is inferenced. Waiting for an inference that never happens (empty store) accomplishes nothing.

A new framing is needed. We exhaustively tried the following before settling on the design below:

| Attempt | Result |
|---|---|
| `pipeline.dispose()` after drain (ADR-0025 draft) | crash persists |
| `intraOpNumThreads: 1, interOpNumThreads: 1` (disable ONNX thread pool) | crash persists |
| `process.reallyExit(code)` (Node's internal `_exit(2)` equivalent) | crash persists — C++ destructors still run |
| `process.exit(code)` (current default) | crash persists |
| Self-`SIGKILL` (`process.kill(process.pid, 'SIGKILL')`) | **bypasses every destructor cleanly** |

`SIGKILL` is the only primitive that skips the C++ destructor chain. The OS reaps the process; no JS code runs after the signal.

The forces in play:

- **The crash is unrecoverable from JS.** No catch, no atexit handler, no `process.on('exit')` hook fires after a libc++ `terminate`. Once we are in the destructor chain, the only options are to be lucky (we are not, reproducibility is 100%) or to never reach it.
- **Exit code semantics change.** A self-`SIGKILL` exits with code `137` (`128 + SIGKILL = 9 + 128`). The intended JS-level exit code is lost. We accept this trade-off because (a) the alternative is exit code `134` from libc++ `abort` with a stack-trace splash, which is strictly worse UX; (b) consumers that care about exit codes either parse the structured JSON envelope on stdout (which still prints correctly) or are looking at "succeeded vs failed" semantics (`134` and `137` are both failures to shell scripts using `$?`, so the change is invisible).
- **Short-lived `--help` / `--version` commands should keep their exit codes.** They never load the embedder; the crash class does not reach them. We gate the `SIGKILL` hatch behind a "the embedder was loaded in this process" check so these stay at clean exit `0`.
- **The hatch is not the proper architecture.** A worker-thread or child-process isolation of the embedder would let the main process exit cleanly while the OS reaps the embedder's threads via the worker's terminate path. This is a real refactor we plan to do separately; the hatch unblocks users today.

## Decision

Three changes, one PR:

1. **`@psraghuveer/memento-embedder-local`** sets a `globalThis.__memento_embedder_loaded` flag the first time its `ensureReady()` promise resolves. The flag is intentionally placed on `globalThis` so the CLI's exit path doesn't have to depend on the embedder package at import time.
2. **`@psraghuveer/memento`'s `nodeIO().exit()`** reads the flag and chooses between two exit paths:
   - **Flag unset** (no embedder loaded — `--help`, `--version`, commands whose work finishes before warmup's first tick): `process.exit(code)`. Preserves the intended exit code. No crash possible because no native thread pool is alive.
   - **Flag set** (embedder loaded — `dashboard`, `serve`, `status`, `pack install`, `memory list`, `import`, every command that opens a `MementoApp` long enough for warmup to complete): drain stdout/stderr, then `process.kill(process.pid, 'SIGKILL')`. Exit code becomes `137`. No destructors run, no race, no crash.
3. **Drain primitives.** Before `SIGKILL`, the exit path calls `process.stdout.write('', cb)` and `process.stderr.write('', cb)` and waits for both callbacks; this ensures piped consumers (`jq`, CI log files, redirected output) receive the full result envelope before the process dies. A `setImmediate(kill)` fallback fires if either drain callback never completes (closed pipe on the consumer end, broken stdio).

The pre-existing ADR-0024 work — the pending-work tracker, `MementoApp.shutdown()`'s three-phase drain, `provider.dispose?()` — is **kept**. It is correct cleanup engineering even though insufficient on its own:

- The tracker drains in-flight inferences so the snapshot returned to the caller reflects committed state.
- `provider.dispose()` releases the transformers.js pipeline handle (useful for hypothetical future providers that hold non-thread native resources — HTTP sessions, file handles, GPU contexts — where graceful release matters).
- The synchronous `close()` and the config key `embedding.startupBackfill.shutdownGraceMs` are unchanged.

The hatch sits **after** all that work. The chain is: drain → dispose → `close()` → return through dispatcher → render → `io.exit()` → `SIGKILL`. Even if the dispose-and-close were a no-op, the `SIGKILL` would still avoid the crash. The two layers serve different purposes — clean cleanup of observable state vs. avoiding the native-destructor race.

## Consequences

### Positive

- The user-reported crash is gone on every command that loads the embedder. The dashboard, the MCP server, and short read commands all exit without `libc++abi` output in stderr.
- The stdout JSON envelope still prints for both interactive users (`memento dashboard` snapshot) and scripted consumers (`memento memory list | jq`).
- Short commands that don't load the embedder (`--help`, `--version`, completion scripts) retain their intended exit codes and natural exit semantics.
- The hatch is data-driven: the `__memento_embedder_loaded` flag is a single point of detection. Future native-module-loading paths (a hypothetical local LLM, a GPU pipeline) can opt into the same hatch by setting the same flag, without touching the CLI's `exit` logic.
- The pre-existing ADR-0024 cleanup engineering is preserved, so any future provider that needs graceful disposal (cloud HTTP backends, file-handle-holding embedders) inherits the framework.

### Negative

- The CLI's exit code is `137` for any command that loads the embedder. CI scripts that strictly assert `$? == 0` will see a regression. Mitigation: the same scripts would see `134` today (`libc++abi abort`), so the change is from "failure with stack trace" to "failure with clean stderr". Scripts that distinguish should switch to parsing the JSON envelope on stdout.
- The hatch is platform-specific (`SIGKILL` is POSIX). On Windows, `process.kill(pid, 'SIGKILL')` is normalised by libuv to `TerminateProcess`, which has the same effect — no destructors. We have not yet observed the crash on Windows (it may be macOS- and Linux-specific to the OpenMP thread teardown order); the hatch is still correct there if needed.
- `globalThis` flags are a soft contract. A future contributor who renames the flag without updating both call sites can silently disable the hatch. Mitigation: a unit test (in `packages/cli/test/exit-codes.test.ts`) pins the flag name + behaviour pair.
- The proper architectural fix (worker-thread isolation of the embedder) is deferred. We accept the hatch as a v1 stopgap with an explicit follow-up tracked as ADR-0027-or-later.

### Risks

- **The flag is set but the threads are not actually loaded yet.** The flag fires when the loader's promise resolves; ONNX session creation runs inside that promise so by the time the flag flips, the threads exist. We verified empirically.
- **A future embedder that doesn't load ONNX still triggers the hatch.** Cloud HTTP-backed providers, for example, wouldn't have the native-thread issue but would still SIGKILL. Mitigation: when those providers exist, they should set a separate flag (e.g. `__memento_native_threads_loaded`) and the CLI checks that one instead. For v1 with the local embedder as the only option, conflating the two is fine.
- **`SIGKILL` is not catchable**, so a `SIGINT` handler that wanted to do something special on shutdown loses the chance. We accept this because (a) we are at `io.exit` time — the shutdown drain has already happened in `MementoApp.shutdown()` — and (b) any handler that wanted to run before the JS process dies has already had the chance during the lifecycle's `finally` block.

## Alternatives considered

### Alternative A: Disable the embedder warmup by default

- **Description.** Set `embedder.local.warmupOnBoot=false` by default. The embedder only loads on first user-facing search. Short commands that don't search never load ONNX.
- **Why attractive.** No native-thread issue if ONNX never loads. Exit codes preserved.
- **Why rejected.** Trades a first-call latency penalty for the crash. The first `memory.search` on a fresh dashboard would block on the model load (~5–10 minutes on a fresh install with no cached ONNX bytes). This is the regression ADR-0021 specifically opted against. Also doesn't help `dashboard`, `serve`, or `pack install` — they all genuinely need the embedder loaded, and they all hit the same crash.

### Alternative B: Worker-thread or child-process isolation of the embedder

- **Description.** Run the embedder inside a `worker_threads.Worker` (or a `child_process.spawn`'d Node process). Terminate the worker on shutdown. The crash, if it happens, happens inside the worker — the main process exits cleanly.
- **Why attractive.** The architecturally correct fix. Cleanly isolates a fragile native dependency. Preserves exit codes. No `SIGKILL` of the main process.
- **Why rejected (for v1).** Big refactor. The embedder is currently a synchronous-feeling API (`provider.embed(text)` returns a Promise of a vector); moving it across a worker boundary means routing every inference through an `MessageChannel` or RPC layer. Concurrency, error propagation, and lifecycle hooks all need rework. We **plan to do this** as the long-term fix; the SIGKILL hatch unblocks users in the meantime. Tracked as a follow-up ADR.

### Alternative C: `process.reallyExit(code)` (Node's internal `_exit(2)` equivalent)

- **Description.** Skip JS-level cleanup but rely on `_exit(2)` to bypass C++ destructors too.
- **Why attractive.** Preserves the exit code (no signal-killed special value).
- **Why rejected.** Verified empirically that it does **not** skip C++ destructors. The crash reproduces identically with `reallyExit`. The libc++ teardown runs regardless.

### Alternative D: `intraOpNumThreads: 1, interOpNumThreads: 1` (disable ONNX's thread pool)

- **Description.** Configure ONNX session options to run inference single-threaded. With only one thread, the multi-thread destructor race shouldn't fire.
- **Why attractive.** Targets the specific failure mode. No platform-specific hatches.
- **Why rejected.** Verified empirically that the crash persists. ONNX still spawns some internal threads (warmup workers, async I/O threads) regardless of the inference thread count. The race is not strictly about the inference thread pool.

### Alternative E: Catch the `SIGINT` and `process.exit(0)` manually (current default)

- **Description.** The status quo: rely on `process.exit(code)` to do the right thing.
- **Why attractive.** No new code.
- **Why rejected.** This is exactly what was crashing.

## Validation against the four principles

1. **First principles.** The smallest construct that bypasses the crash is `SIGKILL`. We verified empirically that no other primitive available from JS skips C++ destructors. The flag-based gating exists because the hatch shouldn't apply to commands that don't load the embedder (where exit codes still matter).
2. **Modular.** The flag is a single point of detection; the hatch is a single branch in `nodeIO().exit()`. The embedder publishes the flag, the CLI consumes it; neither imports the other. Future providers (cloud HTTP, GPU, etc.) can join the contract without changing the CLI.
3. **Extensible.** The same flag mechanism scales: any future native-thread-holding component sets `__memento_embedder_loaded`, gets the `SIGKILL` hatch for free. If we ever want per-component opt-in (e.g. cloud providers that don't need the hatch), the flag name space is open.
4. **Config-driven.** The hatch is unconditional (no config key) because configurability here would let a misconfigured operator re-enable the crash. The existing `embedding.startupBackfill.shutdownGraceMs` continues to bound the drain phase from ADR-0023/0024.

## References

- [ADR-0024](0024-generalize-graceful-shutdown.md) — predecessor. The drain coordination is preserved; the *claim* that drain alone solves the crash is overturned.
- [ADR-0023](0023-graceful-shutdown-for-startup-backfill.md) — the original narrower ancestor (drain only the backfill).
- [ADR-0021](0021-install-time-embedding-and-startup-backfill.md) — introduced the startup backfill / warmup that surfaces the crash.
- [ADR-0006](0006-local-embeddings-only-in-v1.md) — the local-embedder-only posture this hatch is shaped around.
- [`packages/cli/src/io.ts`](../../packages/cli/src/io.ts) — `nodeIO().exit()` with the `SIGKILL` hatch.
- [`packages/embedder-local/src/embedder.ts`](../../packages/embedder-local/src/embedder.ts) — `ensureReady()` sets the `__memento_embedder_loaded` flag.
