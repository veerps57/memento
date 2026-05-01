# Limitations

This document lists the current limitations, gotchas, and out-of-scope areas of Memento. It is maintained alongside every release.

We surface limitations rather than hide them because both human and AI contributors waste real effort assuming things work that don't. If you hit something that should be on this list and isn't, please open an issue.

## Out of scope

These are deliberate omissions. The architecture is designed so that adding any of them is additive (no breaking changes to existing data or APIs), but they are not part of the product today.

| Feature                                  | Why                                                                              | Status                               |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| Cloud embedding providers (OpenAI, etc.) | Memento is fully local-first; cloud belongs to a separate, opt-in trust boundary | Not supported                        |
| Plugin / extension system                | Plugin systems are quality tar pits; the core stays focused                      | `plugin.*` config namespace reserved |
| Multi-user and team-scoped memory        | The data model supports it (`OwnerRef`, extensible `ScopeType`); commands do not | Not supported                        |
| HTTP / SSE transport                     | stdio covers every current MCP client                                            | Not supported                        |
| Encryption at rest                       | Use full-disk encryption or an encrypted volume                                  | Not supported                        |
| Sync across machines                     | `npx @psraghuveer/memento export` / `npx @psraghuveer/memento import` (ADR-0013) cover transfer; live sync is out of scope | Manual transfer only                 |
| Single-binary distribution               | Memento ships on npm                                                             | Not supported                        |
| Web UI / TUI for browsing memory         | Treated as a separate product                                                    | Out of scope                         |

## Active limitations

These are real constraints in the shipping product.

- **Better-sqlite3 prebuild coverage.** Memento depends on `better-sqlite3`, which ships native prebuilds for common platforms (macOS arm64/x64, Linux arm64/x64, Windows x64). Less common platforms (e.g. Linux on uncommon glibc versions, Alpine without `node-gyp` dependencies) require a build step. Supported platforms are enumerated in the install docs.
- **Vector backend is brute-force.** The `retrieval.vector.backend` enum is `{auto, brute-force}`. The brute-force backend scans every active row with an embedding per query; latency is acceptable for stores in the low thousands and degrades linearly above that. A native `sqlite-vec` backend can be added without breaking existing configs.
- **Brute-force vector scan latency.** When `retrieval.vector.enabled` is true, every active embedded memory is scanned per query (cosine similarity in-memory). For stores with tens of thousands of embedded memories this becomes the dominant search cost.
- **Embedding model migration is explicit.** Changing `embedder.local.model` (or `embedder.local.dimension`) leaves stored vectors stamped with the old model. The next vector-enabled search aborts with a `CONFIG_ERROR` pointing at `memento embedding rebuild`; this is by design (Rule 14: model migration must be deliberate).
- **Local embedding model first run.** Vector retrieval is on by default. The first call to `embed()` downloads the local model (`bge-base-en-v1.5`, ~110 MB) to a cache directory. While the download is in progress, search degrades gracefully to FTS-only. Subsequent calls reuse the cached model.
- **Conflict detection scope.** Conflicts are detected within the same scope or against broader scopes (per the `conflict.detectionMode` config). Cross-repo conflict detection is intentionally not enabled by default.
- **Decay parameters.** The default decay half-life is 90 days. This is a heuristic, not a researched value; tune it for your usage. `npx @psraghuveer/memento doctor` surfaces decay statistics to inform tuning.
- **Scrubber is best-effort.** The built-in patterns catch common secret formats but cannot catch every possible secret. The scrubber is one layer of defense; do not assume content written to memory is automatically safe.
- **Audit retention.** Audit events older than `storage.auditRetentionDays` (default 365) are pruned by `npx @psraghuveer/memento compact`. Long-lived audit history requires explicit configuration.
- **Memory kinds are fixed.** The `kind` taxonomy (`fact`, `preference`, `decision`, `todo`, `snippet`) is fixed. User-defined kinds are not supported.
- **Single global store.** All scopes resolve to one SQLite file under the user's home directory. Per-team or per-tenant stores are not supported.

## Behavioral notes worth knowing

These are not bugs, but they are easy to misunderstand.

- **Confidence is "is this currently true," not "how important."** The `confidence` field is used for decay math and ranking. It is not a priority signal. Pinning a memory is the way to mark it important.
- **Scope is immutable.** A memory's scope cannot be changed after creation. Use `supersede` to create a new memory in a different scope and retire the old one.
- **`memory.update` does not change content.** Updates are restricted to non-content fields (tags, kind, pinned). Content changes route through `supersede` to preserve history. The error message points you to the right command.
- **`memento_context` does not auto-confirm memories.** Loading memory into a session does not bump `lastConfirmedAt`; the client must call `memento_confirm` explicitly when a memory was actually used. This keeps decay semantics meaningful.
- **Bulk destructive operations default to `dryRun: true` and always require `confirm: true`.** `memory.forget_many` and `memory.archive_many` rehearse by default; pass `dryRun: false` to actually transition. `confirm: true` is required even for the dry run. Real applies are capped by `safety.bulkDestructiveLimit` (default 1000); rehearsals are uncapped so you can size the blast radius first.

## Where to file issues

If you find something that should be listed here, or a documented limitation that has been resolved and the docs missed it, please [open a bug report](.github/ISSUE_TEMPLATE/bug_report.yml).
