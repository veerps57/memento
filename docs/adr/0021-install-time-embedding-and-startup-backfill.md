# ADR-0021: Install-time embedding (sync) and startup backfill (async)

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Memento Authors
- **Tags:** retrieval, lifecycle, recovery, embedding

## Context

The 0.6.0 launch of [memento packs](0020-memento-packs.md) shipped with a real but invisible defect: pack-installed memories sat at `embeddingStatus: "pending"` indefinitely. Vector retrieval missed them entirely. The user-visible promise of "install pack, get useful semantic recall" was broken on the first session after install, every time.

Two distinct gaps were hiding in the same area:

1. **The `pack.install` handler bypassed the post-write hook chain.** It called `memoryRepository.writeMany` directly, going around the `afterWrite` hook that bootstrap wires for `memory.write_many`. The 0.6.1 hotfix routed pack installs through the same hook chain, which we believed was sufficient.
2. **The `afterWrite` chain itself is fire-and-forget.** Auto-embed is `void (async () => { ... })()` per [ADR-0005](0005-conflict-detection.md)'s pattern for the conflict hook. That works for long-lived servers handling conversational writes — the model loads on first use, the embed completes before anyone notices. It fails for two distinct lifecycles:
   - **One-shot CLI commands** (`memento pack install <id>`, `memento import --in foo.json`) where the process exits as soon as the handler returns. Any in-flight async embed promise dies with it.
   - **Stdio MCP servers with bounded sessions.** A server can be killed within seconds of a batch install if the host (Claude Code, Cursor, etc.) reloads or the user closes the chat. With a cold-start model load that takes 2–5 seconds and a batch of 11 memories firing 11 parallel embed calls, server death easily wins the race. The 0.6.1 hotfix made `afterWrite` fire correctly; it didn't make the work survive process exit.

The launch validation surfaced both: a fresh `npm i -g @psraghuveer/memento && memento pack install engineering-simplicity` produced 11 memories with `embeddingStatus: pending`, and `memory.search` returned vector score 0 for queries that should have hit dead-on. The recovery path (`embedding.rebuild`) worked but required the user to know it existed and run a separate command. That's not the cold-start UX packs were meant to deliver.

The audit that followed found a third related gap: **`importSnapshot` writes memories via raw `trx.insertInto('memories')` SQL.** It bypasses the repository entirely, so the `afterWrite` hook never fires at all — not in 0.6.0, not in 0.6.1, not before packs existed. Imported memories have always silently shipped without embeddings unless the artefact carried pre-computed vectors. The cold-start failure mode the 0.6.0 packs launch hit was a fresh, visible variant of a long-standing footgun.

The forces in play:

- **Discrete batch installs need synchronous embed.** A pack install is a one-shot operation the user is waiting for. Adding a few seconds — or even minutes on first-time model fetch — to the install latency in exchange for "by the time it returns, retrieval works" is a strictly better tradeoff than "returns instantly, retrieval is silently broken until you run a recovery command." The user is patient for installs in a way they are not patient for conversational writes.
- **Conversational writes don't need synchronous embed.** A `memory.write` from inside an active MCP session is fundamentally different. The server is alive, the model has loaded, the embed completes in milliseconds and lands before anyone notices. Forcing sync there would push 100–300 ms onto every write for no UX win. The fire-and-forget pattern is correct for that lifecycle.
- **Recovery must exist for orphan state.** Even with sync embed at install time, real installations will accumulate orphan pending memories: from upgrades that flipped `embedding.autoEmbed` from off to on, from a previous server that did die mid-session, from artefacts whose exports didn't include vectors, from manual `set_embedding` calls that targeted a different model. The system must self-heal these without operator intervention. The existing `embedding.rebuild` command is the explicit recovery tool, but requiring users to know it exists and remember to run it is exactly the gap we are closing.
- **Boot-time backfill must be bounded.** A pathological orphan pool (thousands of pending memories on a heavy store) would pin server boot for minutes if the backfill blocked. The pass must be off-thread, capped, and best-effort, with the explicit `embedding.rebuild` command remaining the path for full-corpus rebuilds.
- **Cross-surface symmetry.** Two install-time write surfaces exist: `pack.install` (registry command) and `importSnapshot` (engine function called from `memento import`). Both need the same fix. They have different write strategies (one through the repo, one raw SQL) but the same failure mode. The fix should compose — a single helper used by both — so the sync-embed contract doesn't drift between them.

## Decision

We close the install-time gap and the historical-orphan gap with two complementary changes, deliberately asymmetric in their semantics:

**Synchronous batch-embed at install time, in `pack.install` and `importSnapshot`.** A new pure helper `embedAndStore(memories, provider, repo, actor)` lives in `@psraghuveer/memento-core/embedding` and runs one `provider.embedBatch` call followed by per-row `repo.setEmbedding` writes. `pack.install` `await`s it after `writeMany` returns, before the handler resolves. `importSnapshot` `await`s it after the import transaction commits (outside the lock), passing only memories the artefact didn't already provide embeddings for. The helper never throws — partial failures are best-effort and recoverable via `embedding.rebuild`. The embedder is wired into both surfaces via callbacks (`PackCommandDeps.embedAndStore`, `ImportOptions.embedAndStore`) that bootstrap and the CLI lifecycle compose from the resolved `EmbeddingProvider`. Conflict detection stays fire-and-forget per [ADR-0005](0005-conflict-detection.md); only auto-embed becomes synchronous, and only for these install-time surfaces.

**Asynchronous bounded backfill at server startup.** Bootstrap kicks off `reembedAll` once at boot, off-thread (the call is not awaited; `createMementoApp` returns before it completes), bounded by a new immutable config key `embedding.startupBackfill.maxRows` (default 1000). The pass scans active memories newest-first, skips rows whose stored vector matches the configured provider's `model` and `dimension`, and embeds the rest in one batch. Failures are swallowed; remaining rows past the cap surface on the next boot or via the explicit `embedding.rebuild` command. A second config key `embedding.startupBackfill.enabled` (default true) lets operators opt out. The pass is a no-op when no embedder is wired (vector retrieval disabled).

The asymmetry — sync for installs, async for everything else — is the load-bearing decision. It is config-driven by accident of `embedding.autoEmbed` and the new `embedding.startupBackfill.*` keys, but the semantic split is intentional: install lifecycles must guarantee retrieval works on first use; conversational writes must stay fast.

## Consequences

**Positive:**

- The cold-start UX packs were designed for actually works. `memento pack install engineering-simplicity` followed by `memory.search` finds the right memories on the first try, with no separate command.
- Imported stores work the same way. A user importing an artefact from another machine gets working semantic recall immediately, even when the artefact didn't carry pre-computed embeddings — closing a gap that pre-dated packs.
- Historical orphan state heals automatically. Users on installs that hit the 0.6.0/0.6.1 race conditions (or any prior fire-and-forget failure) get correct retrieval on the next server boot, without having to learn `embedding.rebuild`.
- The shared `embedAndStore` helper means the install-time contract cannot drift between `pack.install` and `importSnapshot`. A future install-time surface (e.g. extension to `memory.extract`'s batch path, if that ever needs it) can compose the same helper.
- Conversational writes are unaffected. `memory.write`, `memory.write_many`, `memory.extract`, `memory.supersede` all keep their fire-and-forget post-write semantics. Latency cost: zero on the conversational hot path.

**Negative — accepted:**

- `pack.install` and `memento import` now block on embedder readiness. First-ever install on a fresh machine downloads the 435 MB ONNX model before returning — typically 5–10 minutes on average broadband. Subsequent installs are seconds (model cached). We accept this because (a) the model has to download eventually for vector retrieval to work at all, (b) deferring the cost behind a fire-and-forget `void` makes the failure invisible rather than absent, and (c) a future CLI lifecycle change can add a progress indicator during the wait without changing the ADR.
- The `embedAndStore` callback is a new public surface on `PackCommandDeps` and `ImportOptions`. Hosts that don't compose it (or don't supply an embedder) get install paths that succeed without vectors — the same as today minus the silent embed errors. The opt-out story is "leave it undefined" or "set `retrieval.vector.enabled = false`."
- `MementoApp` gains an optional `embeddingProvider` field on its public surface so hosts can compose post-write batch operations from outside command handlers (the CLI import lifecycle being the motivating case). This is additive, optional, and reflects the embedder that bootstrap already holds — it doesn't widen what hosts know about the engine, just makes the existing reference reachable.
- Startup backfill adds boot-time work. Bounded by `embedding.startupBackfill.maxRows` (default 1000); on a clean store it walks one batch, finds nothing stale, and exits in under a millisecond. On a 1000-row backlog it adds ~2–4 seconds of background work that does not block the first request.
- Two new immutable config keys (`embedding.startupBackfill.enabled`, `embedding.startupBackfill.maxRows`) — pinned at server start, mutable only via `configOverrides` at construction. We chose immutable because flipping the backfill behaviour at runtime is operator territory, not assistant territory; a prompt-injected `config.set` shouldn't be able to disable orphan recovery.

**Out of scope, deliberately:**

- **Synchronous embed for `memory.write` / `memory.write_many` / `memory.extract` / `memory.supersede`.** These are conversational writes; their latency budget is small and their failure mode (orphan pending) is fully recovered by the startup backfill. Different tradeoff, different decision.
- **Synchronous post-write conflict detection at install time.** Considered for symmetry. Rejected because (a) [ADR-0005](0005-conflict-detection.md) deliberately made conflict detection fire-and-forget for latency, (b) a missed conflict scan is lower-impact than a missing embedding (most pack memories don't conflict with anything; subsequent confirm/supersede on the memory re-runs the hook), and (c) the explicit recovery tool `conflict.scan since=<ts>` exists and is documented. We may revisit if real users hit it.
- **A periodic background timer.** Considered as an alternative to startup backfill. Rejected: orphans from a prior session don't need a timer, they need one pass; a timer adds always-on work for the rare case.
- **`MementoApp.close()` awaiting in-flight async work.** Considered to close the in-session race window. Rejected: redundant with startup backfill and adds shutdown latency for one-shot CLI commands.
- **A user-facing config knob for "sync vs async at install time."** Premature. Sync is the right default; async at install time is a regression. Revisit only if a real use case appears.
- **Progress indicator during the 5–10 minute first-time model download.** UX work in CLI lifecycle code, not in the engine. Worth doing as a follow-up; doesn't belong in this ADR.

## Alternatives considered

- **Auto-trigger `embedding.rebuild` at the end of `pack.install`.** Cheap, packs-specific. Rejected because (a) it only solves embeddings for that one path, (b) it creates code asymmetry — `memory.write_many` would still go through the conventional hook chain while `pack.install` had its own bespoke recovery, (c) `embedding.rebuild`'s contract is full-corpus rebuild, not "embed these N memories," so co-opting it would either be wasteful or require parameter expansion that turns it into a different command. The shared `embedAndStore` helper is the right abstraction.
- **Print a hint in `pack install` output: "✓ 11 memories installed. Run `memento embeddings rebuild` to enable semantic search."** Trivially cheap, mediocre UX. Acceptable as a stop-gap if the sync-embed design took weeks; it doesn't, so we ship the actual fix instead. Documenting the shape of the problem in operator-facing copy is a separate concern from solving it.
- **Refactor `importSnapshot` to route through `memoryRepository.writeMany`.** That would automatically pick up the `afterWrite` hook chain and benefit from any future hook addition. Rejected because the import transaction has carefully-tuned semantics around event chains, conflict copies, and scope rewrites that would need to flow through the repository's write API in ways that don't currently exist. The post-commit `embedAndStore` is a much smaller blast radius and keeps the import transaction's ACID story intact.
- **Track "last successful conflict scan" in a system-level state record and replay missed scans at boot, symmetric to the embedding backfill.** Considered for completeness. Rejected for this PR because (a) the existing `conflict.scan since=<ts>` recovery tool is explicit and documented, (b) the impact of a missed conflict scan is significantly lower than a missed embedding, (c) implementing it would expand the surface area of this PR meaningfully (new config keys, new system state, new bootstrap task) for marginal gain. If real users hit it, address in a follow-up.
- **Make startup backfill blocking (await it inside `createMementoApp`).** Tempting because it guarantees correctness at the cost of boot latency. Rejected because for one-shot CLI lifecycles (a `memento status` or `memento doctor` invocation) the boot wait would dominate the command's runtime and produce surprising delays. Off-thread with bounded scope is the right tradeoff: long-lived MCP sessions benefit, one-shot CLIs return fast and rely on `embedAndStore` at the call sites that actually need vectors guaranteed.

## Implementation summary

- New module `packages/core/src/embedding/embed-and-store.ts` — pure helper, never throws, batch-first with per-row fallback.
- `packages/core/src/commands/packs/commands.ts` — split `afterWrite` (conflict, fire-and-forget) from `embedAndStore` (sync); install handler `await`s the latter on the fresh-write batch.
- `packages/core/src/portability/import.ts` — track inserted memories and which had artefact-supplied embeddings; post-commit, call `embedAndStore` on those that didn't.
- `packages/core/src/bootstrap.ts` — wire the conflict-only `afterWrite` and the new `embedAndStore` callback into `createPackCommands`; expose `embeddingProvider` on `MementoApp`; kick off bounded `reembedAll` post-bootstrap when an embedder is wired.
- `packages/cli/src/lifecycle/import.ts` — switch from bare `deps.createApp` to `openAppForSurface` so the embedder is wired; compose the `embedAndStore` callback from `app.embeddingProvider`.
- `packages/schema/src/config-keys.ts` — add `embedding.startupBackfill.enabled` (bool, default true, immutable) and `embedding.startupBackfill.maxRows` (int, default 1000, immutable).
- Tests across `packages/core/test/commands/packs.test.ts`, `packages/core/test/portability/round-trip.test.ts`, `packages/core/test/bootstrap.test.ts` cover the sync contract, the post-commit pass, the artefact-already-has-embedding skip, the no-embedder-wired skip, the `enabled = false` skip, the `maxRows` cap, and the embedder-failure soft-fail.
