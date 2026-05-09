---
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-schema': minor
'@psraghuveer/memento': patch
---

Fix install-time embeddings (sync) + add startup backfill for orphan recovery (ADR-0021).

The 0.6.0 packs launch shipped a defect that the 0.6.1 hotfix only partially closed: pack-installed memories silently landed at `embeddingStatus: pending` because the post-write `afterWrite` chain — even after we wired it — runs `auto-embed` as fire-and-forget. The CLI process (or the MCP server) often exited before the async embed work resolved, leaving every `pack.install` and every `memento import` with broken vector retrieval until the user ran `embedding.rebuild` by hand. An audit found `importSnapshot` had the same gap pre-dating packs entirely (it writes via raw SQL and never hit the hook chain at all).

Three changes, one PR:

- **`pack.install` now embeds synchronously.** A new `PackCommandDeps.embedAndStore` callback runs `provider.embedBatch` over every freshly-written memory and persists vectors via `repo.setEmbedding` before the handler resolves. Conflict detection stays fire-and-forget per ADR-0005; only auto-embed becomes synchronous, and only on this install-time surface.
- **`importSnapshot` embeds post-commit.** A new `ImportOptions.embedAndStore` callback fires after the import transaction commits (outside the lock) on freshly-inserted memories whose artefact didn't carry pre-computed vectors. Same partial-failure policy: never throws, recovery via `embedding.rebuild`. The CLI's `memento import` lifecycle composes the callback from the wired `EmbeddingProvider`.
- **Bootstrap kicks off a bounded startup backfill.** When an embedder is wired and `embedding.startupBackfill.enabled` is true (default), `createMementoApp` runs `reembedAll` once at boot — off-thread (does not block first request), bounded by `embedding.startupBackfill.maxRows` (default 1000), best-effort. Drains orphan pending state from any source: previous-session crashes, prior buggy install paths, manually-toggled `embedding.autoEmbed`, imports that pre-date this PR.

Public API additions:

- `embedAndStore(memories, provider, repo, actor)` and `EmbedAndStoreResult` exported from `@psraghuveer/memento-core/embedding`.
- `MementoApp.embeddingProvider?: EmbeddingProvider` — the wired provider, exposed so hosts can compose post-write batch operations.
- `PackCommandDeps.embedAndStore` callback (optional).
- `ImportOptions.embedAndStore` callback (optional).
- New immutable config keys `embedding.startupBackfill.enabled` (bool, default `true`) and `embedding.startupBackfill.maxRows` (int, default `1000`).

Behavioural impact: `pack.install` and `memento import` now block on embedder readiness. With the model warm, the install latency cost is typically a few seconds. With a fresh machine and no cached model, the first install downloads 435 MB of ONNX before returning — typically 5–10 minutes on average broadband. We accept this because deferring the cost behind fire-and-forget made the failure invisible rather than absent. Conversational write paths (`memory.write`, `memory.write_many`, `memory.extract`, `memory.supersede`) are unchanged — they remain fire-and-forget; the startup backfill heals their orphans on next boot.

Closes the cold-start gap end-to-end: a fresh `npm i -g @psraghuveer/memento && memento pack install <id>` produces a store with working semantic recall on the first session.
