# Memento packs

Packs are curated YAML files of memories you can install in one step. They're how you go from "fresh install" to "useful memory layer" without typing out the same preferences and conventions every time. They're also how you share a stack guide (Rust + Axum, TypeScript + pnpm, Python + uv…) or a personal set of conventions with someone else.

This guide covers what packs are, how to install and uninstall them, how to author your own, and how to share. The full architectural rationale is in [ADR-0020](../adr/0020-memento-packs.md).

## What's in a pack

A pack is a single YAML file. Here's a minimal one:

<!-- pack-example -->

```yaml
format: memento-pack/v1
id: rust-axum
version: 1.0.0
title: Rust + Axum web service conventions
description: Conventions for building Axum-based services.
memories:
  - kind: fact
    content: Axum is the canonical Rust web framework here.
  - kind: preference
    content: |
      build-tool: cargo
      Always use cargo for builds; never invoke rustc directly.
    tags: [build]
  - kind: decision
    content: Auth via Axum extractors, not middleware.
    rationale: Extractors compose with handler types and surface errors at compile time.
    tags: [auth]
```

Every pack has:

- **`format`** — always `memento-pack/v1`. The version negotiation point. Future v2 readers will refuse v1 artefacts; v1 readers warn-and-skip unknown fields a v1.x manifest may carry.
- **`id`** — lowercase kebab-case, 2–32 chars, starting with a letter (`^[a-z][a-z0-9-]{1,31}$`). Used in the provenance tag.
- **`version`** — semver `MAJOR.MINOR.PATCH` with optional lowercase prerelease (`-rc.1`, `-alpha`). Build metadata (`+...`) is not allowed.
- **`title`** — one-line human-readable name, ≤ 200 chars.
- **`memories`** — non-empty array of memory items. Each item has a `kind` (`fact`, `preference`, `decision`, `todo`, `snippet`), `content`, and optional `summary`, `tags`, `pinned`, `sensitive`, plus kind-specific fields (`rationale` for decisions, `due` for todos, `language` for snippets).

Optional metadata fields: `description` (≤ 2000 chars), `author`, `license` (SPDX), `homepage` (HTTPS URL), `tags` (pack-discovery tags, ≤ 20), and `defaults` (`scope`, `pinned`, `tags` applied to every memory unless overridden per-item).

## Installing

Three ways to install, all routing through the same `pack.install` command:

### From a local file

```bash
memento pack install --from-file ./my-pack.yaml
```

### From a bundled pack id

```bash
memento pack install rust-axum --version 1.0.0
```

Bundled packs live under the directory named by `packs.bundledRegistryPath` (immutable, default `null` — set by the runtime to the package's bundled directory). Layout: `<root>/<id>/v<version>.yaml`.

### From an HTTPS URL

```bash
memento pack install --from-url https://example.com/pack.yaml
```

URL fetches are HTTPS-only, do not follow redirects, abort on first byte over `packs.maxPackSizeBytes` (default 1 MiB), and time out at `packs.urlFetchTimeoutMs` (default 10 seconds). Disable URL installs entirely by setting `packs.allowRemoteUrls=false`.

### Preview before installing

```bash
memento pack preview --from-file ./my-pack.yaml
```

`pack.preview` resolves and parses the manifest, classifies the install state (`fresh` / `idempotent` / `drift`), and returns the items without persisting. Useful for diffing what an `install` would do.

### What install actually does

Per memory, the install path:

1. Resolves the manifest YAML (bundled / file / URL).
2. Parses it through `PackManifestSchema`. Unknown top-level keys produce warnings; schema violations produce a structured error with the YAML line/column.
3. Builds a `MemoryWriteInput[]`: merges `defaults` into each item, appends the canonical provenance tag `pack:<id>:<version>`, generates a deterministic `clientToken` content-hashed with the item's contents.
4. Pre-flight checks: counts existing memories tagged `pack:<id>:<version>` in the install scope, compares clientTokens, classifies the install (fresh / idempotent / drift).
5. If fresh, runs `memory.write_many` — which in turn runs the standard scrubber, stamps `OwnerRef` local-self, and emits a `created` event per memory.

Re-installing the same manifest is idempotent (no writes, no events). The pack is treated as already installed.

### Refusal: PACK_VERSION_REUSED

Editing a pack's content without bumping the version trips the drift check on next install:

```text
pack.install: pack content has changed without a version bump
(2 expected, 2 present, 1 new, 1 stale).
Bump the manifest version (1.0.0 → next) before re-installing.
```

This catches the "I edited the YAML but kept v1.0.0" footgun. Mint a new version (`1.0.1`, `1.1.0`, …) and re-install — the previous version's memories stay until you uninstall them.

## Uninstalling

`pack.uninstall` is a thin wrapper over `memory.forget_many` filtered by the pack's tag:

```bash
memento pack uninstall rust-axum --version 1.0.0 --confirm
```

Defaults to `--dry-run` per [ADR-0014](../adr/0014-bulk-destructive-operations.md). Pass `--dry-run=false` (or omit the flag and confirm via the dashboard) to actually forget. Each per-memory transition emits a normal `forgotten` event — the audit log shape is identical to manual `memory.forget` calls.

To remove every version of a pack:

```bash
memento pack uninstall rust-axum --all-versions --confirm
```

Forgotten memories are soft-removed; restore via `memento memory restore <id>` if you change your mind, or re-install the pack to bring them back fresh.

## Listing installed packs

```bash
memento pack list
```

Returns one row per `(id, version, scope)` group: id, version, scope, count of active memories carrying the tag. The dashboard's `/packs` tab renders the same data with per-pack uninstall buttons.

## Authoring a pack

`memento pack create` builds a YAML file from memories already in your store. Two flows:

### Interactive (stdin is a TTY, no filter flags)

```bash
memento pack create my-stack --version 0.1.0 --title "My stack conventions" --out ./my-stack.yaml
```

Walks every active memory in the store and asks keep / skip. The kept set is bundled into the manifest. Cancel with Ctrl-C.

### Non-interactive (filter flags)

```bash
memento pack create my-stack \
  --version 0.1.0 \
  --title "My stack conventions" \
  --out ./my-stack.yaml \
  --scope-global \
  --kind preference \
  --tag build
```

Filter flags (`--scope-global` / `--scope-workspace=<path>` / `--scope-repo=<remote>`, `--kind`, `--tag` repeatable, `--pinned`) map directly to the `MemoryListFilter` shape that `memory.list` uses. Passing any filter flag bypasses interactive review entirely so scripted pipelines stay deterministic.

`--out=-` writes the YAML to stdout instead of a file (useful for piping into another tool).

### What `pack create` does NOT do

- Does not write to multiple scopes. Pack memories share one scope (`PackMemoryItem` has no per-item scope field). If your selection spans more than one, the command refuses with `INVALID_INPUT`. Narrow with `--scope-*` and run twice.
- Does not include reserved-prefix tags. `pack:*` tags are stripped from per-memory tags on export (with a warning). The install path stamps a fresh `pack:<id>:<version>` tag on every memory; carrying old pack provenance into a new pack would be confusing and would conflict with the schema.

## Provenance

Every pack-installed memory carries the canonical tag `pack:<id>:<version>`. The tag is the entire provenance — no new event variant, no new column on `Memory`. Query it with the standard tag filter:

```bash
memento memory list --tag pack:rust-axum:1.0.0
```

`pack:` is a reserved tag prefix. User-authored writes (`memory.write`, `memory.write_many`, `memory.extract`) reject any tag starting with `pack:` so provenance can't be forged. Only the pack-install path writes these tags.

## Sharing packs

There's no central pack registry. Three ways to share a pack you've authored:

1. **As a file.** Email it, attach it to a Slack message, drop it in your team's wiki. Recipients run `memento pack install --from-file ./pack.yaml`.
2. **As an HTTPS URL.** Host the YAML anywhere — a GitHub raw URL works. Recipients run `memento pack install --from-url https://...`. The fetch is gated by `packs.allowRemoteUrls` (default true) and capped at 1 MiB.
3. **As a community contribution.** A separate repo (`memento-packs`) collects community-authored packs. Add a YAML file via PR and the install flow becomes `memento pack install --from-url https://raw.githubusercontent.com/...`.

The YAML format is human-readable and `git diff`-friendly. A reviewer can see exactly what they'll be installing without running anything.

## Configuration

Five config keys govern pack behaviour:

| Key | Default | Mutable | Purpose |
|---|---|---|---|
| `packs.bundledRegistryPath` | `null` | no | Filesystem path to the directory containing bundled packs. Pinned at server start. |
| `packs.allowRemoteUrls` | `true` | yes | Master switch for `--from-url`. Flip to `false` in restricted environments. |
| `packs.urlFetchTimeoutMs` | `10000` | yes | Per-request timeout for URL fetches. |
| `packs.maxPackSizeBytes` | `1048576` | yes | Per-fetch size cap (applies to local files and URL responses). |
| `packs.maxMemoriesPerPack` | `200` | yes | Maximum number of memories a manifest may contain. |

Set with `memento config set packs.<key> <value>` (mutable keys only). Inspect with `memento config list packs`.

The integrity rules — re-stamp `OwnerRef` local-self, re-scrub on install, refuse-on-content-drift, reserved `pack:` tag prefix, deterministic `clientToken` — are hardcoded invariants per [AGENTS.md](../../AGENTS.md) Rule 12. They are not configurable.

## Dashboard

The dashboard's `/packs` tab (per [ADR-0018](../adr/0018-dashboard-package.md)) surfaces:

- Every installed pack as a row (id, version, scope, memory count) with a per-row uninstall button.
- A small install form with two source modes: bundled id (+ optional version) and HTTPS URL.
- A callout that documents the CLI authoring flow (`memento pack create`) — the dashboard does not author packs.

Open the dashboard with `memento dashboard`; navigate via the sidebar or `⌘K > pack`.

## FAQ

**Why not use `memento export` / `memento import` for sharing?** They solve a different problem. Export/import ([ADR-0013](../adr/0013-portable-export-import.md)) preserves the source store's audit history for cross-machine restore; the JSONL format requires synthetic IDs and event chains and is not authoring-friendly. Packs are hand-authored content; the YAML format optimises for that.

**Why does the install path re-stamp `OwnerRef` to local-self?** Same reason as `memento import` ([ADR-0019](../adr/0019-import-re-stamp-policy.md)): never trust caller-supplied audit claims. The install path treats every pack source — bundled, file, URL — as untrusted by default. The scrubber re-runs on every memory's content, the canonical tag is appended, and the standard `created` event records the local actor and timestamp.

**Can I install two versions of the same pack at once?** Yes. Each version stamps its own tag (`pack:rust-axum:1.0.0` and `pack:rust-axum:1.1.0` would coexist). They typically don't, because `pack uninstall` is part of the upgrade flow, but the model permits it. `pack list` shows them as separate rows.

**Can I edit a pack-installed memory after install?** Yes — pack-installed memories are normal memories. `memento memory update` (tags, kind, pinned), `memento memory supersede` (content), `memento memory forget` (soft-remove). The `pack:<id>:<version>` tag stays on the row through any of those transitions, so `pack uninstall` still finds and forgets your edited version.

**What happens if I install a v1.x pack that uses a v1.x feature my client doesn't know about?** Unknown top-level keys (e.g. a future `embeddings:` block) emit a warning and are stripped before validation. Unknown per-item keys inside a known field (e.g. a typo in `language`) fail with a structured error pointing at the YAML line.

**My pack has secrets in `content`. Will install scrub them?** Yes. The scrubber runs on every memory's `content`, `summary`, and (for decisions) `rationale` at install time, regardless of where the pack came from. The scrubber's rule set is the importer's current set, not the source's — see [`scrubber.md`](../architecture/scrubber.md) for what's matched.

**Does the pack format support config keys?** Not in v1. A pack is purely a memory bundle. Future v1.x additions may include a `config:` block; the parser already accepts unknown top-level keys with a warning, so a pack that opts into the future field continues to install on v1 with the config block silently dropped.

## See also

- [ADR-0020](../adr/0020-memento-packs.md) — full design and rationale.
- [ADR-0013](../adr/0013-portable-export-import.md) — the wire format we did not adopt as authoring format and why.
- [ADR-0014](../adr/0014-bulk-destructive-operations.md) — the dry-run-default + confirm gate `pack.uninstall` inherits.
- [ADR-0019](../adr/0019-import-re-stamp-policy.md) — the re-stamp / re-scrub semantic model the install path follows.
- [`scope-semantics.md`](../architecture/scope-semantics.md) — how scope works at write and read time.
- [`scrubber.md`](../architecture/scrubber.md) — what's redacted on install.
