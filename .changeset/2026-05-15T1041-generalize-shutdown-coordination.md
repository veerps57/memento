---
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-schema': patch
---

Generalise graceful shutdown coordination to all fire-and-forget background work (ADR-0024 supersedes ADR-0023).

A user running v0.7.1 against an **empty store** still hit the original `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument` abort on Ctrl-C of `memento dashboard`. With an empty store the startup backfill is a no-op, so ADR-0023's single-promise wait had nothing to await — but the embedder warmup (`void embeddingProvider.warmup()` at boot, also fire-and-forget) was still loading the ONNX pipeline. Tearing down the worker threads mid-load aborts the process exactly as before.

The fix replaces ADR-0023's single `pendingBackfill: Promise<void> | null` slot with a `Set<Promise<unknown>>` plus a `trackBackgroundWork(promise)` helper inside `createMementoApp`. Every fire-and-forget call site in `bootstrap.ts` registers via the helper:

- Post-write conflict hooks (3 sites: `memory.*`, `extract`, `pack.install`)
- Post-write auto-embed (2 sites: `memory.*`, `extract`)
- Startup backfill (1 site)
- Embedder warmup (1 site)

`MementoApp.shutdown()` snapshots the tracker and races `Promise.allSettled([...set])` against the existing timer driven by `embedding.startupBackfill.shutdownGraceMs`. The set self-prunes — every wrapped promise removes itself on settle via `finally` — so memory stays bounded over write-heavy sessions. The helper's internal `.catch(() => {})` makes the best-effort posture explicit; a rejection in a tracked task never produces an unhandled-rejection warning, and shutdown's only failure mode is "timed out waiting."

Public surface: **unchanged.** `MementoApp.shutdown()` signature is unchanged; its JSDoc broadens to reflect the wider scope. Synchronous `close()` is preserved exactly as ADR-0023 left it. Lifecycle commands continue to `await app.shutdown()` in their `finally` blocks. The config key keeps the name `embedding.startupBackfill.shutdownGraceMs` for backwards compatibility with v0.7.1 operator overrides (the description is updated to document the broader scope; a future major bump can rename).

Two new regression tests in `bootstrap.test.ts`:

- `awaits the in-flight embedder warmup before closing the database` — pins the user-reported reproducer.
- `awaits in-flight post-write auto-embed before closing the database` — pins the write-then-Ctrl-C race.

The four pre-existing ADR-0023 shutdown tests still pass; they exercise the backfill case, which the new tracker handles via the same mechanism.
