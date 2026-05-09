---
'@psraghuveer/memento-core': patch
---

Fix `pack.install` to fire post-write hooks (conflict detection + auto-embed) for every freshly-written memory.

The original implementation called `memoryRepository.writeMany` directly, going around the command-level `afterWrite` chain that bootstrap wires through for `memory.write_many` and `memory.extract`. Result: pack-installed memories silently skipped both hooks. Two visible consequences:

- **Embeddings stayed at `pending`** until the user ran `embedding.rebuild` manually. Vector retrieval missed every pack-installed memory until that explicit rebuild — the cold-start UX (`memento pack install <id>` → useful semantic recall) was broken on the first session.
- **Conflict detection didn't fire** on pack-installed memories. A pack that contradicts an existing memory wouldn't open a conflict.

`pack.install` now mirrors the `memory.write_many` / `memory.extract` shape: an optional `afterWrite` callback in `PackCommandDeps` that fires once per freshly-written memory (idempotent items resolved by `clientToken` are skipped, same as the rest of the write surface). Bootstrap wires the same `runConflictHook` + auto-embed chain that the other write paths use.

Coverage: three new tests in `packages/core/test/commands/packs.test.ts` — hook fires per fresh write, hook does not fire on idempotent re-installs, and an end-to-end test that installs a pack with a fake embedding provider and asserts every written memory ends with `embeddingStatus: "present"`.
