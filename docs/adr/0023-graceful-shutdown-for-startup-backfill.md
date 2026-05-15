# ADR-0023: Graceful shutdown coordination for the startup embedding backfill

- **Status:** Accepted (amends [ADR-0021](0021-install-time-embedding-and-startup-backfill.md) §Out-of-scope)
- **Date:** 2026-05-15
- **Deciders:** Memento Authors
- **Tags:** lifecycle, embedding, reliability, recovery

## Context

[ADR-0021](0021-install-time-embedding-and-startup-backfill.md) shipped two complementary changes — synchronous embedding at install time, and an asynchronous bounded startup backfill at boot — to close the cold-start retrieval gap. The backfill was deliberately fire-and-forget per a sub-decision in that ADR's "Out of scope, deliberately" section, which read:

> **`MementoApp.close()` awaiting in-flight async work.** Considered to close the in-session race window. Rejected: redundant with startup backfill and adds shutdown latency for one-shot CLI commands.

That rejection was wrong, and the wrongness manifests as a hard crash. A user running `memento dashboard` (long-lived process, waits on SIGINT) hits Ctrl-C while the startup backfill is mid-inference. The current handler closes the HTTP server, then calls `app.close()` which closes SQLite synchronously, then returns. The Node.js process tries to exit. Native modules tear down. The embedder (`@huggingface/transformers` over ONNX Runtime) has worker threads still parked from the in-flight `embedBatch` call; their destructors race with the threads' internal `std::mutex` operations. The process aborts with `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument`.

The race window is small but reliably hit on:

- A first-time install where the backfill is still loading the 435 MB ONNX model when the user Ctrl-Cs an exploratory `memento dashboard` to look at something else.
- A heavy store where the backfill scans hundreds of rows and a batch is mid-inference when the user hits Ctrl-C.
- Any `memento serve` over stdio where the host (Claude Code, Cursor) reloads or the user closes the chat mid-batch.

The forces in play:

- **The crash is unrecoverable.** Once libc++ aborts, no signal handler runs, no JS catch fires, no cleanup happens. The user sees a stack trace, not a clean exit. On a fresh-install dashboard session, this is the first impression Memento makes.
- **Cancellation is not available.** ONNX Runtime does not expose mid-inference cancellation. The only way to avoid tearing down the embedder mid-inference is to **wait** for the inference to complete.
- **Waiting cannot be unbounded.** A pathological backfill (1000 rows on a cold model) could pin a user-initiated shutdown for minutes. Ctrl-C must remain responsive.
- **ADR-0021's reasoning for rejecting shutdown coordination was incomplete.** The "redundant with startup backfill" argument assumes the next boot recovers the orphan state — true, but it doesn't help the *current* process which has already aborted, and it doesn't recover the user's trust after a stack-trace exit. The "adds shutdown latency for one-shot CLI commands" argument assumes the latency is unbounded; a configurable grace window with a short default (single-digit seconds) is operationally invisible.
- **Two-pass close is desirable.** Embedded callers and tests that don't run signal-driven lifecycles want the existing synchronous `close()` preserved. The fix is additive (new graceful path), not replacing.

## Decision

Add a new method `MementoApp.shutdown(): Promise<void>` that awaits the in-flight startup backfill up to a config-driven grace window, then calls the existing synchronous `close()`. Every CLI lifecycle command — `dashboard`, `serve`, `status`, `doctor`, `init`, `backup`, `import`, `pack`, `context`, plus the registry adapter in `registry-run.ts` — switches its `try { ... } finally { app.close() }` pattern to `try { ... } finally { await app.shutdown() }`. The synchronous `close()` stays on the interface so embedded callers and tests that coordinate teardown another way keep working.

A new config key `embedding.startupBackfill.shutdownGraceMs` (number, default `3000`, mutable, range `0`–`60_000`) sets the grace window. The grace-window timer races the backfill promise; whichever resolves first wins. Setting it to `0` skips the wait entirely (fire-and-forget shutdown, equivalent to the pre-ADR-0023 behaviour — only safe when the host coordinates teardown another way).

The implementation is a `Promise.race([pendingBackfill, timer])` followed by the existing synchronous close. The backfill closure's `try/catch` already swallows errors, so `shutdown` cannot throw; it is idempotent via the same `closed` flag that guards `close`. The mechanism deliberately does **not** attempt to abort the backfill — ONNX has no cancellation primitive, and a graceful drain is what avoids the native-thread teardown race in the first place.

## Consequences

### Positive

- The `mutex lock failed` crash on `memento dashboard` Ctrl-C is closed. The same mitigation covers every lifecycle command — a user who Ctrl-Cs `memento pack install` mid-batch (rare but possible) gets a clean exit rather than a libc++ abort.
- The fix is opt-in for hosts. Embedded callers and tests that don't run signal-driven lifecycles can keep using `close()` and pay zero cost. CLI lifecycle commands that hit the race window get the graceful drain.
- The grace window is short by default (3 seconds) and config-driven, so operators with restrictive systemd timeouts can dial it down, and users with very slow disks can dial it up. Default value chosen to drain a typical ONNX inference batch without making Ctrl-C feel unresponsive.
- The synchronous `close()` semantics are preserved bit-for-bit. Tests that spy on close-was-called migrate to spying on shutdown-was-called; the contract (cleanup runs exactly once, idempotent, releases the DB) is the same.

### Negative

- New API surface: one method on `MementoApp` (`shutdown`) and one config key (`embedding.startupBackfill.shutdownGraceMs`). Per [ADR-0003](0003-single-command-registry.md), the engine surface is conservative; this addition is justified by the crash it closes and by the impossibility of solving the same problem inside `close()` without breaking embedded callers.
- Slightly more lifecycle code: each lifecycle command's `finally` block goes from `app.close()` to `await app.shutdown()`. The async hop is invisible in commands without a backfill running (no-op in microtask time) and bounded by the grace window otherwise.
- The fix masks a deeper class of problem (any native-thread embedder that doesn't expose cancellation) without solving it. We accept this — solving cancellation properly would require the embedder package to grow that surface, which is outside the project's scope.

### Risks

- **Grace window too short for a real workload.** If a user's batch consistently takes longer than the configured grace, shutdown will time out and the crash returns. Mitigation: the 3000 ms default is generous for typical bge-small inference (well under 1 s per batch on modern hardware); operators with heavy workloads can extend via config. If the default proves wrong in the wild, we adjust the default — a one-line change.
- **A new long-running async task added later (post-write conflict scans, future workers) re-introduces the race.** Mitigation: the `pendingBackfill` slot is currently single-purpose; if more background work appears, generalise to a `pendingWork: Promise<unknown>[]` and `Promise.all` the lot inside `shutdown`. The generalisation is one PR away when needed.
- **`shutdown` is bypassed because a caller forgets to await it.** A test or host that calls `app.shutdown()` without `await` discards the promise; the cleanup still happens but the process can exit before the grace window completes, re-opening the race. Mitigation: TypeScript `Promise<void>` return type is the contract; we don't enforce await syntactically. The lifecycle commands all `await` correctly; embedded callers who need shutdown ergonomics will discover the contract from the JSDoc.

## Alternatives considered

### Alternative A: Block `createMementoApp` until the backfill completes

- **Description.** Make `createMementoApp` itself await `reembedAll` before returning, so by the time the app is usable, the backfill is already done — no in-flight work to coordinate with at shutdown.
- **Why attractive.** Eliminates the race window entirely. No new API. No new config.
- **Why rejected.** Already considered and rejected in [ADR-0021](0021-install-time-embedding-and-startup-backfill.md) ("Make startup backfill blocking"): for one-shot CLI lifecycles (`memento status`, `memento doctor`) the boot wait dominates the command's runtime and produces surprising delays. The asymmetry ADR-0021 chose — sync at install time, async at boot — is the right shape. Adding a separate graceful-shutdown path preserves that asymmetry while closing the crash window.

### Alternative B: Expose `cancel()` on `EmbeddingProvider` and call it on shutdown

- **Description.** Add a method to the provider interface that signals abort; `shutdown` calls it and waits a short timeout for the embedder to unwind.
- **Why attractive.** Faster shutdown — no need to wait for the in-flight batch to complete.
- **Why rejected.** ONNX Runtime does not expose mid-inference cancellation. `@huggingface/transformers` would have to expose a cancellation API it does not currently have. Adding the field on `EmbeddingProvider` without any implementation backing it would be misleading. Defer to a future ADR if a cancellation-capable embedder is wired.

### Alternative C: Skip the backfill in lifecycle commands that aren't long-lived

- **Description.** Add an option to `createMementoApp` (`skipStartupBackfill: boolean`) and pass `true` for `status`, `doctor`, etc. — short-lived commands don't trigger backfill, so there's no race.
- **Why attractive.** Surgical. Targets only the commands that don't benefit from backfill anyway.
- **Why rejected.** The race is reachable on `dashboard` and `serve` regardless of any skip flag — those are exactly the commands that *should* run backfill. A skip flag doesn't help them. Adding the graceful-shutdown path covers every lifecycle uniformly; a skip flag would be a parallel mechanism with worse coverage.

### Alternative D: Catch `process.exit` and delay it

- **Description.** Install a `process.on('exit')` handler that blocks (via spinwait or Atomics.wait) until the backfill resolves.
- **Why attractive.** Doesn't require changing any lifecycle command.
- **Why rejected.** Node's `process.exit` handler runs synchronously and cannot await promises. Atomics.wait on a SharedArrayBuffer would work in theory but adds a substantial new mechanism (SAB + atomic flag + spin) for a problem that has a cleaner async solution. Goes against the grain of how Node lifecycle is supposed to be structured.

## Validation against the four principles

1. **First principles.** The crash is the forcing function. The smallest construct that prevents it is "await the in-flight work before tearing down native modules"; that is exactly what `shutdown` does, with the grace window bounding the wait. No mechanism shipped without justification — `cancel()`, `process.on('exit')`, and global signal handlers were all considered and rejected as oversized.
2. **Modular.** `shutdown` is a thin composition of the existing `close` and a config-driven wait against the `pendingBackfill` promise. Replacing the wait strategy (e.g. switching to a cancellation-aware embedder) is one closure change. Replacing `close` is independent. Lifecycle commands compose `shutdown` from the public interface; no command depends on the internal `pendingBackfill` slot.
3. **Extensible.** When new background work joins the engine (a periodic conflict scan, a worker for X), the single-promise `pendingBackfill` slot becomes a list and `shutdown` awaits `Promise.all`. The API on `MementoApp` does not change. The config key generalises to a single shutdown-grace knob.
4. **Config-driven.** The grace window is `embedding.startupBackfill.shutdownGraceMs` — a `ConfigKey` per Rule 2. Default value is justified by typical inference latency, not pulled from thin air. Operators in restricted environments can dial it down to 0 (back to fire-and-forget) or up to 60 seconds (slow disk recovery).

## References

- [ADR-0021](0021-install-time-embedding-and-startup-backfill.md) — the install-time embedding ADR this amends. Its "Out of scope, deliberately" item on `close()` awaiting in-flight work is reversed by this ADR; the underlying decision (sync at install, async startup backfill) is preserved.
- [ADR-0005](0005-conflict-detection-post-write-hook.md) — the fire-and-forget post-write hook pattern, similarly unchanged in this ADR.
- [`packages/core/src/bootstrap.ts`](../../packages/core/src/bootstrap.ts) — the `pendingBackfill` slot and `shutdown` implementation.
- [`packages/schema/src/config-keys.ts`](../../packages/schema/src/config-keys.ts) — the new `embedding.startupBackfill.shutdownGraceMs` key.
