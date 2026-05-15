# Bundled packs

Curated YAML bundles of memories that ship with Memento. Each pack lives at `<id>/v<version>.yaml`. The full guide — what packs are, how to install one, how to author your own — is at [docs/guides/packs.md](https://github.com/veerps57/memento/blob/main/docs/guides/packs.md).

## What's bundled

| Pack                                                           | Title                                                  | Scope  | Memories |
| -------------------------------------------------------------- | ------------------------------------------------------ | ------ | -------- |
| [`engineering-simplicity`](engineering-simplicity/v0.1.0.yaml) | Engineering through the Laws of Simplicity             | global | 11       |
| [`pragmatic-programmer`](pragmatic-programmer/v0.1.0.yaml)     | The Pragmatic Programmer — heuristics for engineering  | global | 13       |
| [`twelve-factor-app`](twelve-factor-app/v0.1.0.yaml)           | The Twelve-Factor App — methodology for SaaS services  | global | 13       |
| [`google-sre`](google-sre/v0.1.0.yaml)                         | Google SRE — principles for running reliable services  | global | 11       |

## Editing an existing pack

Two flavors of edit, two paths.

**Substantive change** — anything that affects what gets installed: memory `content`, `kind`, `summary`, `tags`, `pinned`, `sensitive`, kind-specific fields (`rationale` / `due` / `language`), or `defaults.{scope,pinned,tags}`. Copy `v<old>.yaml` to a new version file, edit there, leave the old version in place so existing installs stay stable.

Pick the semver bump deliberately:

- **patch** (`0.1.0` → `0.1.1`) — wording tweak in one memory
- **minor** (`0.1.0` → `0.2.0`) — added memories, expanded coverage, broader scope
- **major** (`0.1.0` → `1.0.0`) — removed memories, structural rewrite, breaking change

The drift check (`PACK_VERSION_REUSED`) refuses re-installing a published version with changed content; that refusal is the system telling you a bump is required.

**Cosmetic only** — `title`, `description`, `author`, `license`, `homepage`, top-level pack-discovery `tags`. Edit `v<version>.yaml` in place at the same version. The drift hash excludes these fields, so the install path treats the new file as identical to the old.

After either path: run `pnpm format:packs && pnpm test packages/core/test/packs/`, then open a PR. CI runs `pnpm verify`, which includes `format:packs:check` and the bundled-pack schema test.

## Contributing a new pack

The full walkthrough is [Authoring a pack](https://github.com/veerps57/memento/blob/main/docs/guides/packs.md#authoring-a-pack) in the guide. The TL;DR:

1. Drop a `<id>/v<version>.yaml` under this directory.
2. Add the `# yaml-language-server: $schema=https://runmemento.com/schemas/memento-pack-v1.json` header so editors validate live.
3. `pnpm format:packs` to canonicalise key order, scalar style, and final-newline policy.
4. `pnpm test packages/core/test/packs/` — the bundled-pack test parses your file against the live `PackManifestSchema` and asserts the directory layout matches.
5. PR.
