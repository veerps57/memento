# ADR-0024: Generalize graceful shutdown to all background work

- **Status:** Accepted (supersedes [ADR-0023](0023-graceful-shutdown-for-startup-backfill.md))
- **Date:** 2026-05-15
- **Deciders:** Memento Authors
- **Tags:** lifecycle, embedding, reliability, recovery

## Context

[ADR-0023](0023-graceful-shutdown-for-startup-backfill.md) added `MementoApp.shutdown()` to drain the in-flight startup embedding backfill before closing the database. The fix was correct for the path it covered but the scope was wrong. A user running v0.7.1 against an **empty store** still hit the original `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument` abort on Ctrl-C of `memento dashboard` — with an empty store the backfill is a no-op, so the wait the ADR-0023 fix added had nothing to wait on.

An audit of `bootstrap.ts` found six other fire-and-forget paths that share the same race class:

- **The embedder warmup** at `bootstrap.ts:451`. `void embeddingProvider.warmup()` drives `runtime.pipeline('feature-extraction', repo, …)`, which loads the ONNX model and spins up worker threads. Active on every boot when `embedder.local.warmupOnBoot` is true (default), regardless of store contents. **This was the user's actual crash.**
- **Post-write conflict hooks** at `bootstrap.ts:223`, `:291`, `:366`. `void runConflictHook(...)` fires per memory write across `memory.*`, `extract`, and `pack.install`. Bounded by `conflict.timeoutMs` but still runs against the ONNX worker if the conflict detector touches a vector path during scoring.
- **Post-write auto-embed** at `bootstrap.ts:232`, `:296`. `void (async () => { … provider.embed(...) … })()` after every write in `memory.*` and `extract`. The most write-frequent ONNX caller in the engine; trivially hit by writing a memory then immediately Ctrl-Cing.

ADR-0023's single `pendingBackfill: Promise<void> | null` slot only tracked one of these. The other six remained fire-and-forget, racing native-module teardown exactly as before. The decision in ADR-0023 was right; the *mechanism* was too narrow.

The forces in play:

- **Same problem, repeated.** Every fire-and-forget call site that touches a native module is a potential crash. Fixing them one by one with one slot per source bloats the API, scales linearly with new background work, and is easy to forget. A single mechanism is the durable fix.
- **The pattern is asymmetric over time.** The backfill and warmup run once at boot — bounded. The post-write hooks run per write — unbounded over a long session. The mechanism has to track both without growing memory linearly with write count.
- **Cancellation still isn't an option.** ONNX Runtime exposes no mid-inference cancellation. The mechanism is still "wait for the work to drain, with a bounded grace window" — the same shape ADR-0023 chose, just applied to more promises.
- **The grace-window config key is fine.** ADR-0023 introduced `embedding.startupBackfill.shutdownGraceMs` (default 3000, mutable, range 0–60_000) for the backfill case. The semantics generalise cleanly: "how long to wait for all tracked background work." The historical prefix is misleading but renaming a config key that shipped to npm hours ago for a cosmetic improvement is the wrong cost-benefit trade. We update the description and document the historical name in place.

## Decision

Replace ADR-0023's single `pendingBackfill: Promise<void> | null` slot with a self-pruning `pendingBackgroundWork: Set<Promise<unknown>>` plus a `trackBackgroundWork(promise)` helper inside `createMementoApp`. Every fire-and-forget call site in `bootstrap.ts` — post-write conflict hooks (3 sites), post-write auto-embed (2 sites), startup backfill (1 site), embedder warmup (1 site) — wraps its promise via `trackBackgroundWork` instead of `void`-discarding it.

```ts
const pendingBackgroundWork = new Set<Promise<unknown>>();
const trackBackgroundWork = (promise: Promise<unknown>): void => {
  const wrapped = promise.catch(() => {});           // never reject
  pendingBackgroundWork.add(wrapped);
  wrapped.finally(() => {
    pendingBackgroundWork.delete(wrapped);            // self-prune
  });
};
```

`MementoApp.shutdown()` snapshots the set and races `Promise.allSettled([...pendingBackgroundWork])` against a timer driven by `embedding.startupBackfill.shutdownGraceMs`. The set is bounded by promise-resolution time (each tracked task removes itself on settle), so memory stays bounded over long sessions even with thousands of writes. The helper's internal `.catch(() => {})` makes the best-effort posture explicit: a rejection in a tracked task never produces an `UnhandledPromiseRejectionWarning`, and shutdown's only failure mode remains "timed out waiting for the work to drain."

The config key keeps the name `embedding.startupBackfill.shutdownGraceMs` for backwards compatibility with v0.7.1 operator overrides. The description is updated to reflect the broader scope. A future major bump can rename to `lifecycle.shutdownGraceMs` if the historical prefix becomes a real source of confusion; for now the cost of breaking an operator override outweighs the cosmetic win.

The public `MementoApp.shutdown()` signature does not change. Synchronous `close()` is preserved exactly as ADR-0023 left it. Lifecycle commands continue to `await app.shutdown()` in their `finally` blocks. ADR-0023's other decisions (when to use `close` vs `shutdown`, the default grace value, the no-cancellation-of-ONNX posture) are all preserved.

## Consequences

### Positive

- The libc++ mutex crash is closed for every reachable background-work path. The user-reported reproducer (`memento dashboard` against an empty store → Ctrl-C → abort) now exits cleanly because the warmup promise is in the tracker.
- A single mechanism covers every fire-and-forget site, present and future. New background work that lands in `bootstrap.ts` just calls `trackBackgroundWork(promise)` once and inherits shutdown coordination for free.
- The tracker is memory-bounded by construction. Every `wrapped.finally` removes the entry on settle, so a write-heavy session (thousands of post-write hooks per minute) does not leak. The set holds only currently-pending promises.
- The API surface does not grow. `MementoApp.shutdown()` and its config key are exactly as ADR-0023 left them; only the implementation generalises.
- The defensive `.catch(() => {})` in the helper eliminates a category of bug — every tracked task is rejection-safe. Future callers can `trackBackgroundWork(somePromise)` without remembering to add their own catch.

### Negative

- `Promise.allSettled([...pendingBackgroundWork])` snapshots the set at shutdown start. Tasks that race in *after* shutdown begins are not awaited. In practice the HTTP/MCP transports are closed first, so new tasks should be rare; but a worst-case write that lands between "transport close" and "shutdown begin" can slip through. We accept this — the alternative (loop-drain until the set is stably empty) adds complexity for vanishing benefit.
- The config key name (`embedding.startupBackfill.shutdownGraceMs`) is now misleading: it covers all background work, not just the backfill. We accept the cosmetic mismatch to avoid breaking v0.7.1 operator overrides. The description in `config-keys.ts` documents the broader scope; a future major bump can rename if the historical prefix proves confusing.
- ADR-0023 is superseded after one PR. Reviewers and AI agents loading both ADRs see the lineage; readers landing on ADR-0023 directly find the `Superseded by ADR-0024` pointer at the top.

### Risks

- **Hidden coupling: a future tracked task that never resolves.** A task that hangs forever would burn the full grace window on every shutdown. Mitigation: the grace window is bounded (3s default, 60s max), so the worst case is a 60-second shutdown — not a hang. Operators can tune down.
- **`finally` callback that throws.** `wrapped.finally(removeFromSet)` would create an UnhandledPromiseRejectionWarning if `Set.prototype.delete` threw. In practice `delete` cannot throw, but the pattern is fragile if the body grows. Keep the `finally` body trivial.
- **Generalising the mechanism beyond `bootstrap.ts`.** If consumers of `@psraghuveer/memento-core` start running their own background work outside the engine, they have no access to this tracker. Mitigation: the tracker is an internal mechanism; external consumers manage their own teardown. If a real use case appears, expose `MementoApp.trackBackgroundWork` as a public method.

## Alternatives considered

### Alternative A: Add a second slot for warmup, keep one-slot-per-source

- **Description.** Extend ADR-0023's pattern. `pendingBackfill` joins a sibling `pendingWarmup` slot. `shutdown` awaits both with `Promise.all`.
- **Why attractive.** Minimal diff. No new abstraction.
- **Why rejected.** The post-write hooks need the same treatment. With six fire-and-forget paths, six named slots is API bloat and a discipline cliff — every new background task lands a new slot, and any forgetful contributor reintroduces the race. The tracker is one mechanism for all of them.

### Alternative B: Promise.race against a single accumulator promise that grows

- **Description.** Maintain a single `Promise<void>` that gets `Promise.all`-replaced every time work is added. `shutdown` awaits the accumulator.
- **Why attractive.** Single-promise shape, no Set.
- **Why rejected.** Reassigning an "accumulator" promise on each write is racy — there's a window where a freshly registered task isn't yet in the accumulator. The Set-with-self-prune pattern is the standard solution; reinventing it is friction.

### Alternative C: Loop-drain (keep awaiting until the set is stably empty)

- **Description.** After the first `Promise.allSettled`, check if the set has grown; if so, drain again. Repeat until the set stays empty for one round.
- **Why attractive.** Catches late arrivals.
- **Why rejected.** Late arrivals during shutdown should be vanishingly rare (HTTP/MCP transports are closed first). The loop adds complexity for a case that shouldn't happen in practice. If it ever becomes a real issue, the change is local to the drain block.

### Alternative D: Expose `trackBackgroundWork` on `MementoApp`

- **Description.** Make the tracker public so external consumers of `@psraghuveer/memento-core` can register their own background work.
- **Why attractive.** Symmetric for embedded callers running their own work.
- **Why rejected.** No real use case yet. Speculative API growth. Trivial to expose later if needed — the implementation is already factored.

## Validation against the four principles

1. **First principles.** Every fire-and-forget call site that touches a native module is a potential crash. The smallest construct that fixes all of them at once is a tracker every site registers with; one-slot-per-source bloats the API and is forgettable. The tracker exists because the per-source approach scales badly with new background work — provable need.
2. **Modular.** `pendingBackgroundWork` + `trackBackgroundWork` live in `bootstrap.ts` as a closure-scoped detail. Replacing them with a different tracker (e.g. one with priority levels, structured logging, etc.) is one local change. The shape of `MementoApp.shutdown` and the config key are unchanged.
3. **Extensible.** New fire-and-forget work joins by calling `trackBackgroundWork(promise)`. No method signature changes. No new config keys. The mechanism scales to any number of background sources without API growth.
4. **Config-driven.** The grace window is `embedding.startupBackfill.shutdownGraceMs` — a `ConfigKey` per Rule 2, same as ADR-0023 introduced. Default value (3000 ms) covers typical ONNX inference batch latency. Operators dial it down to 0 (back to fire-and-forget shutdown) or up to 60_000 (slow disks, model downloads in flight) without code changes.

## References

- [ADR-0023](0023-graceful-shutdown-for-startup-backfill.md) — the narrower predecessor this ADR supersedes. The decision was right (graceful shutdown of background work); the mechanism was too narrow.
- [ADR-0021](0021-install-time-embedding-and-startup-backfill.md) — the original fire-and-forget startup backfill, which ADR-0023 amended for shutdown coordination and this ADR generalises to cover warmup + post-write hooks.
- [ADR-0005](0005-conflict-detection-post-write-hook.md) — the fire-and-forget post-write conflict pattern, now tracked by the shutdown mechanism without changing its runtime semantics.
- [`packages/core/src/bootstrap.ts`](../../packages/core/src/bootstrap.ts) — the tracker, the seven `trackBackgroundWork` call sites, and the rewritten `shutdown` implementation.
- [`packages/schema/src/config-keys.ts`](../../packages/schema/src/config-keys.ts) — the updated description on `embedding.startupBackfill.shutdownGraceMs`.
