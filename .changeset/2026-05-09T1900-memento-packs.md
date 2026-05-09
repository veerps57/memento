---
'@psraghuveer/memento': minor
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-schema': minor
'@psraghuveer/memento-dashboard': minor
---

Add Memento Packs — installable YAML bundles of memories that close the cold-start gap (an empty memory store has no value).

- `memento pack install <id>` seeds your store from a curated bundle. One pack ships in this release: `engineering-simplicity` — 11 memories adapted from John Maeda's *The Laws of Simplicity* with original engineering applications, CC0-1.0. Use `memento pack list` to see what's installed and `memento pack preview <id>` to inspect a pack before committing.
- Three install sources: bundled (`memento pack install engineering-simplicity`), local file (`--from-file ./pack.yaml`), or HTTPS URL (`--from-url https://...`). URL fetches are HTTPS-only, capped at `packs.maxPackSizeBytes` (default 1 MiB), and time out at `packs.urlFetchTimeoutMs` (default 10s). Disable URL installs with `packs.allowRemoteUrls=false`.
- Bundled lookups support omitting `--version`: the resolver scans the pack directory and picks the highest semver, with stable beating prerelease per semver §11.
- Drift detection is built in. Re-installing the same version with edited content fails fast with `PACK_VERSION_REUSED`; bump the version (e.g. `v0.1.0` → `v0.1.1`) to ship changes. Cosmetic edits to pack-level metadata (title, description, license, tags) don't trigger drift.
- Provenance is the canonical tag `pack:<id>:<version>`. `memento memory list --tag pack:engineering-simplicity:0.1.0` shows exactly what a pack contributed; `memento pack uninstall <id>` removes it via `memory.forget_many`. The `pack:` prefix is reserved — user writes can't forge it.
- Author your own with `memento pack create` — interactive prompts walk through filtering existing memories into a YAML pack, or pass flags for non-interactive use. The format is `memento-pack/v1`; full authoring guide at [docs/guides/packs.md](https://github.com/veerps57/memento/blob/main/docs/guides/packs.md), JSON Schema at [docs/reference/pack-schema.json](https://github.com/veerps57/memento/blob/main/docs/reference/pack-schema.json).
- The dashboard gains a `/packs` tab: browse installed packs, preview a pack's memories, install or uninstall via the UI — same engine as the CLI behind it.

Design rationale: [ADR-0020](https://github.com/veerps57/memento/blob/main/docs/adr/0020-memento-packs.md).
