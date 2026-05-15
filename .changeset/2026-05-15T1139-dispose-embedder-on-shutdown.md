---
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-embedder-local': minor
'@psraghuveer/memento': patch
---

Stop the `libc++abi: mutex lock failed: Invalid argument` crash on process exit for every command that loads the local embedder (ADR-0025 supersedes ADR-0024).

A user upgraded to v0.7.2 (the ADR-0024 release) against an empty store and still hit the crash on Ctrl-C of `memento dashboard`. A focused bisection found the crash class is universal: every command that loads the embedder — `dashboard`, `serve`, `status`, `memory list`, `pack install`, `import` — was exiting with code 134 and a libc++ stack trace, even when the work itself succeeded. The crash is the destructor race between `better-sqlite3` and `onnxruntime-node` (loaded transitively by the local embedder via transformers.js) at process teardown.

We exhaustively tried every disposal primitive available from JS — `pipeline.dispose()`, `intraOpNumThreads: 1`, `process.reallyExit(code)` (Node's `_exit(2)` equivalent) — and verified empirically that none of them skips the C++ destructor chain. The only primitive that does is `SIGKILL` to self.

The fix has three layers:

- **Embedder flag.** `@psraghuveer/memento-embedder-local`'s `ensureReady()` sets a `globalThis.__memento_embedder_loaded` flag the first time its loader resolves. The flag is on `globalThis` so the CLI doesn't have to depend on the embedder package at import time.
- **CLI exit hatch.** `@psraghuveer/memento`'s `nodeIO().exit()` reads the flag. When the embedder was loaded in this process, it drains stdout/stderr and self-`SIGKILL`s — bypassing every C++ destructor, never reaching the libc++ trap. When the flag is unset (`--help`, `--version`, short commands that exit before warmup completes), `process.exit(code)` is called normally and the exit code is preserved.
- **`MementoApp.shutdown()` keeps its three-phase teardown** from the (rewritten) ADR-0025: drain in-flight background work → call `provider.dispose()` (if defined) → run the synchronous `close()`. The dispose path is correct cleanup engineering even though insufficient on its own to avoid the crash; it stays so future providers (cloud HTTP-backed, GPU-backed) with non-thread native resources can release them gracefully.

New public surface:

- `EmbeddingProvider.dispose?(): Promise<void>` — optional, called from `shutdown()` after the drain phase.
- `MementoApp.shutdown()` semantics broadened from "drain only" to "drain + dispose + close".
- No new config keys. The existing `embedding.startupBackfill.shutdownGraceMs` continues to bound the drain phase.

Behaviour change for shell consumers: commands that loaded the embedder now exit with code `137` (SIGKILL) instead of `134` (libc++ abort) or the pre-ADR-0024 intended exit code. Both pre- and post-fix values are non-zero — scripts using `$?` to gate success/failure see no regression. Scripts that strictly require exit code `0` from `memento status` etc. should switch to parsing the structured JSON envelope on stdout, which now prints reliably before the process dies.

The architecturally correct fix — worker-thread isolation of the embedder so the main process exits cleanly while a worker terminate disposes ONNX — is deferred as a follow-up. ADR-0025 §Alternative B documents the rationale.
