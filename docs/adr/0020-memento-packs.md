# ADR-0020: Memento packs — curated YAML bundles for cold-start seeding

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Memento Authors
- **Tags:** adoption, lifecycle, distribution, authoring

## Context

A fresh Memento install is empty. An empty store does nothing useful — the assistant has no preferences to recall, no decisions to confirm, no conventions to enforce — so the first session after install is indistinguishable from the assistant having no memory at all. The user has to *populate the store before getting value*, and there is currently no path for that beyond writing memories one at a time. The user-story audit groups this under adoption: "I just installed Memento. What now?"

The three existing population mechanisms each solve a different problem and none of them solve cold-start:

- **`memento import`** ([ADR-0013](0013-portable-export-import.md)) is the wire format for machine-to-machine portability. Every record carries a synthetic ULID, a full `OwnerRef`, an event chain, and a footer SHA — the artefact is optimised for round-tripping a real store, not for hand-authoring a curated bundle. Authoring a `memento-export/v1` JSONL by hand is hostile UX: the user has to mint synthetic ids, fabricate event timestamps, and pretend the file came out of a store that never existed. Nothing in the format is geared for the "I want to share my Rust+Axum conventions with the world" use case.
- **`memory.extract`** ([ADR-0016](0016-assisted-extraction-and-context-injection.md)) compounds passive use over time — once the assistant has a few sessions of context, extraction snowballs. But on a fresh install there is *nothing to anchor on*: the extractor's dedup against existing memories is trivial when there are no existing memories, and the first batch lands at the lower extracted-confidence (0.8) so it decays faster than hand-authored content. Extraction is a flywheel, and a flywheel needs a push.
- **`memento init`** ([packages/cli/src/lifecycle/init.ts](../../packages/cli/src/lifecycle/init.ts:1)) is print-only MCP client setup. By design it does not write to the store — it prints copy-paste snippets for Claude Desktop, Cursor, etc. and exits. Conflating it with memory seeding would mix two unrelated concerns and break the `init` failure mode (today, `init` is safely re-runnable; making it write memory would change that).

The forces in play:

- **Authoring must be hand-friendly.** A pack is a curated artefact written by a human. Multi-line memory content is the norm (a snippet, a rationale, a non-trivial preference); JSON's escaped-newline strings are a usability cliff. The format must support literal multi-line blocks, kind-discriminated entries, and zero ceremony beyond what the data model itself requires.
- **Install must be safe.** Pack content arrives from a third party (a community contributor, a teammate, a public URL). The same threat model that drove [ADR-0019](0019-import-re-stamp-policy.md) applies: the importer must never trust caller-supplied owner claims, audit chains, or arbitrary scrubber output. The install path re-stamps `OwnerRef` to local-self, runs the importer's current scrubber, and emits a fresh `created` event whose payload records pack provenance.
- **Re-install must be idempotent.** Users will run `memento pack install <id>` more than once — to upgrade, to recover from a failed install, or accidentally. Re-running the same install must be a no-op; re-running with a different version must upgrade safely.
- **Content drift must be caught.** A pack author who edits a pack's content but forgets to bump the version creates a silent inconsistency: two users with `pack:rust-axum:1.0.0` may have different memories. Refusing the second install with a structured error is the minimum honest behaviour.
- **Uninstall must be clean.** A user who tries a pack and dislikes it must be able to remove every memory the pack created, in one command, with no orphans. The audit log must continue to show what was there.
- **Distribution must be free of central infrastructure.** Memento is local-first and pre-1.0. We will not stand up a registry server, a sign-in flow, or a payment system to ship v1. A pack must install from a bundled directory, a local file, or an HTTPS URL — three sources, one install path.
- **Provenance must travel.** When the user runs `memory.list` and sees a memory, they must be able to tell whether it came from a pack and which one. The provenance must round-trip through export/import without special handling.

## Decision

We add a YAML pack format **`memento-pack/v1`** and a set of registry commands `pack.{install, preview, uninstall, list, export}` plus thin CLI lifecycle wrappers that handle file IO. A pack is a YAML file declaring metadata (id, version, title, description, default scope, default tags, license, homepage) and a list of memory items keyed by `kind`. The installer is a pure function that translates a parsed manifest into a `MemoryWriteInput[]`; the registry command composes that with `memory.write_many`. Every pack-installed memory is tagged `pack:<id>:<version>` — a reserved tag prefix that user-authored writes cannot use — and that single tag is the entire provenance: it identifies the pack and version a memory came from, drives clean uninstall via tag filter, and is round-trippable through export/import without special handling. Uninstall is a thin wrapper over `memory.forget_many` filtered by that tag, inheriting the dry-run-default and `confirm: z.literal(true)` gate from [ADR-0014](0014-bulk-destructive-operations.md). Manifests resolve from one of three sources: a bundled directory at the path named by `packs.bundledRegistryPath`, a local file via `--from-file`, or an HTTPS URL via `--from-url` (gated by `packs.allowRemoteUrls`, capped by `packs.maxPackSizeBytes`, timed out by `packs.urlFetchTimeoutMs`). The dashboard surfaces pack browse and install/uninstall as a "Packs" tab built entirely on these registry commands ([ADR-0018](0018-dashboard-package.md) §Decision: thin projection only).

### Format — `memento-pack/v1`

The artefact is UTF-8 YAML with the top-level shape:

```yaml
format: memento-pack/v1
id: rust-axum                      # ^[a-z][a-z0-9-]{1,31}$
version: 1.2.0                     # semver
title: Rust + Axum web service conventions
description: >
  Conventions for building Axum-based services — error handling,
  extractor patterns, project layout.
author: github.com/some-user       # diagnostic only; not trusted
license: CC0-1.0                   # SPDX identifier
homepage: https://github.com/...
tags: [rust, web, axum]            # pack-discovery tags, not memory tags

defaults:
  scope: { type: global }          # caller may override at install time
  pinned: false
  tags: []                         # `pack:<id>:<version>` is appended automatically

memories:
  - kind: preference
    content: |
      build-tool: cargo
      Use `cargo` for all Rust builds; never invoke rustc directly.
    tags: [build]
  - kind: decision
    content: |
      Auth via Axum extractors, not middleware.
    rationale: |
      Extractors compose with handler types and surface errors at compile time.
    tags: [auth]
```

The `format` field is the version negotiation point. v1 readers parse v1 artefacts; v1 readers presented with v2 artefacts refuse with `INVALID_INPUT` and a clear "this Memento doesn't know format v2" message. v1 readers presented with a v1 artefact carrying *unknown top-level fields* (a forward-compat additive in v1.x) emit a `Result.warnings` entry and continue — same posture as `memento import`'s schema-version-skew handling ([ADR-0013](0013-portable-export-import.md) §schema-version-skew).

The pack's `id` is validated against `^[a-z][a-z0-9-]{1,31}$` — 2 to 32 chars. The cap is tighter than the bare-tag character allowance because the full provenance tag `pack:<id>:<version>` must fit inside the 64-char `TagSchema` ceiling once a typical semver version is appended. The separator is `:` (not `@`) for the same reason: `@` is not in the existing tag character set (`^[a-z0-9][a-z0-9._:/-]*$`), and `:` is already the conventional namespace separator there. Pack version is similarly constrained: `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9.-]+)?$` with a 24-char ceiling — semver MAJOR.MINOR.PATCH plus an optional lowercase prerelease, no build metadata (semver `+` is also outside the tag character set, and build metadata is ignored for ordering anyway).

YAML is chosen over JSON because authoring is the primary use case and YAML's literal-block syntax (`|`) makes multi-line memory content tolerable. We rejected JSON-for-symmetry-with-import because import and authoring are different problems (see Alternative A below).

### Install semantics

The install path is composable from operations that already exist:

1. **Resolve the manifest.** `BundledResolver`, `FileResolver`, and `UrlResolver` implement a single `PackSourceResolver` interface. The CLI flag (`<id>`, `--from-file`, `--from-url`) selects which resolver runs. URL fetches are HTTPS-only, do not follow redirects, and abort on first byte exceeding `packs.maxPackSizeBytes`.
2. **Parse and validate.** YAML → `PackManifestSchema` (Zod). Validation errors carry the YAML line/column. Unknown top-level keys produce warnings, not errors.
3. **Build write items.** For each memory in `manifest.memories`, merge `manifest.defaults`, append the reserved tag `pack:<id>:<version>`, apply scope override if the caller passed one, and generate a deterministic `clientToken = sha256(packId + version + index)`. The `clientToken` is what makes re-install idempotent ([memory write path](../../packages/core/src/storage/memory-repository.ts) §clientToken — per-scope, per-token uniqueness via partial index).
4. **Detect content drift.** Compute a stable canonical JSON hash over `manifest.memories` (excluding cosmetic fields: title, description, author). Compare against memories already tagged `pack:<id>:<version>`. If the existing set's clientToken hashes match the new manifest's, the install is a no-op (`alreadyInstalled: true`). If they diverge, refuse with `PACK_VERSION_REUSED` — the pack author must bump the version.
5. **Run the standard write path.** The translated items go through `memory.write_many` unchanged: the scrubber runs on every `content`/`summary`/`rationale`, `OwnerRef` is stamped local-self by the command layer, and a `created` event is emitted per memory. No new event variant or payload extension is added — the canonical `pack:<id>:<version>` tag is the entire pack provenance, queryable via the standard tag filter.
6. **Return a structured snapshot.** `{ dryRun, written: [...], skipped: [...], alreadyInstalled, packId, version }`. Mirrors the shape of the import snapshot for caller ergonomics.

The integrity rules — re-stamp, scrub, refuse-on-content-drift, reserved tag — are hardcoded invariants per Rule 12. They are not configurable. The performance and safety knobs — URL allow, size cap, timeout, max memories per pack — are `ConfigKey`s per Rule 2.

### Uninstall semantics

`pack.uninstall <id> [--version <version>] [--all-versions]` resolves to a `memory.forget_many` filter on the `pack:<id>:<version>` tag (or the prefix `pack:<id>:` if `--all-versions`). Inherits everything from [ADR-0014](0014-bulk-destructive-operations.md): dry-run defaults to `true`, `confirm: z.literal(true)` is required even in dry-run, the bulk-destructive cap (`safety.bulkDestructiveLimit`) applies. Each per-row transition is a normal `forgotten` event — the audit log shows the same shape as a manual `memory.forget` call, with no special "uninstalled" event variant. Rule 6 (status transitions are explicit) is preserved because the underlying primitive is `forget`, not a new transition.

Uninstall is reversible via existing `memory.restore` — the per-row events make this work without any pack-system changes. A user who uninstalls and changes their mind runs `memory.restore` against the affected ids (visible in the dry-run snapshot) or re-installs the pack.

### Authoring (`pack.export` and `memento pack create`)

`pack.export` is a registry read command that takes a `MemoryListFilter` plus manifest metadata (id, version, title, …) and returns a YAML string. `memento pack create --out <path>` is the lifecycle wrapper that writes that string to a file. With `--filter` the command is non-interactive; without filter on a TTY it runs an interactive review (per-memory keep/skip/edit) using `@clack/prompts`. The CLI is the only consumer of the prompts library — `core` and `schema` remain free of UI dependencies.

The export-import round-trip is *not* byte-equivalent for the audit log. A pack authored from store A and installed into store B produces fresh `created` events on B, with pack provenance on the source field. This matches the [ADR-0019](0019-import-re-stamp-policy.md) posture: imports never carry the source's audit chain unless `--trust-source` is set, and packs do not have a `--trust-source` carve-out (packs do not have a meaningful event chain to preserve in the first place — they are authored, not exported-then-imported).

### Reserved tag prefix `pack:*`

The tag `pack:<id>:<version>` is the load-bearing piece of provenance. To prevent forgery and accidental collision, user-authored writes (`memory.write`, `memory.write_many`, `memory.extract`) reject any tag matching `^pack:`. The pack install path threads an internal flag (`source: 'pack-install'`) through the write context that the schema refinement consults — only `pack-install` writes may use the reserved prefix. This is a Rule 12 invariant, not configurable.

### Config keys

Five new `packs.*` keys (added per Rule 2):

| Key | Default | Mutable | Purpose |
|---|---|---|---|
| `packs.bundledRegistryPath` | repo-root `packs/` | no | Directory containing bundled packs. Immutable so it cannot be flipped at runtime to point at attacker-controlled paths. |
| `packs.allowRemoteUrls` | `true` | yes | Master switch for `--from-url`. Operators in restricted environments flip to `false`. |
| `packs.urlFetchTimeoutMs` | `10_000` | yes | Per-request timeout for URL fetches. |
| `packs.maxPackSizeBytes` | `1_048_576` (1 MiB) | yes | Total bytes cap on URL responses. Stops streaming on first byte over. |
| `packs.maxMemoriesPerPack` | `200` | yes | Per-pack ceiling. Refuse with `INVALID_INPUT` over the cap. |

### Bundled packs and distribution

Bundled packs are *data*, not code. They live at repo root in `packs/<id>/v<version>.yaml`. The directory layout supports multiple versions side by side (e.g., `packs/ts-monorepo-pnpm/v1.0.0.yaml` and `v1.1.0.yaml`); the resolver picks the version requested or the highest semver if unversioned. Adding a pack is a YAML file plus a snapshot test that loads-and-validates every bundled pack — no engine change. Bundled packs ship in this repo. Community packs live in a separate repo (`memento-packs`) and install via `--from-url` against GitHub raw URLs. There is no central registry server.

### Surface map

| Command | Surfaces | Side effect | One-line job |
|---|---|---|---|
| `pack.list` | mcp, cli, dashboard | read | List installed packs, grouped by `pack:*` tag |
| `pack.preview` | mcp, cli, dashboard | read | Resolve and parse a manifest, return what would be installed |
| `pack.install` | mcp, cli, dashboard | write | Install a pack via `memory.write_many` |
| `pack.uninstall` | mcp, cli, dashboard | destructive | `forget_many` filter on `pack:<id>:<version>` tag |
| `pack.export` | mcp, cli, dashboard | read | Assemble a manifest YAML from a list filter |

The CLI lifecycle adds:

- `memento pack install <id-or-path>` — wraps `pack.install` with `--from-file` / `--from-url` resolution and pretty-printed preview
- `memento pack create --out <path>` — wraps `pack.export` with file IO and (when TTY + no `--filter`) interactive review via `@clack/prompts`

`memento init` is unchanged. Its text walkthrough gains a one-line suggestion in the footer ("Next: `memento pack install <id>` to seed your store"); the command itself remains print-only, write-free, and re-runnable.

## Consequences

### Positive

- The cold-start adoption gap closes with a single command. A user who runs `memento pack install ts-monorepo-pnpm` after `memento init` has a populated store in under 30 seconds.
- Packs are a free distribution channel for community contributors. Each authored pack is an artefact the contributor can share — every contribution is light marketing for Memento, every install is the project meeting a new user where their stack is.
- Authoring is hand-friendly. YAML literal blocks make multi-line content (a snippet, a rationale, a sub-paragraph preference) tolerable to write and trivial to read in `git diff`.
- Provenance is first-class and reversible. Every pack-installed memory carries `pack:<id>:<version>` in its tags. `memory.list --tag pack:rust-axum:1.2.0` shows exactly what a pack contributed; `pack.uninstall` removes it cleanly. No new event variant or column is needed — the tag IS the provenance.
- Re-install is idempotent. Deterministic `clientToken`s plus the existing per-scope uniqueness index mean running `pack install` twice is a no-op without any new code path.
- Content drift is caught. A pack author who forgets to bump the version is told by `PACK_VERSION_REUSED`, not by users discovering inconsistencies in the wild.
- The dashboard gets a Packs tab for free. Per [ADR-0018](0018-dashboard-package.md), the dashboard is a thin projection of registry commands; pack browsing and install/uninstall are exactly that. No new core commands are needed for dashboard support.
- The four guiding principles all pull in the same direction (see Validation below). Notably, the install path is a *pure function* over the manifest; the integration with `memory.write_many` happens at the command layer, leaving the engine reusable for hypothetical future "pack a workflow" or "pack a config bundle" features without rework.

### Negative

- A second authoring/wire format alongside `memento-export/v1`. The two solve different problems (authoring vs round-trip portability) so the duplication is justified — but readers of the codebase must internalise both. The ADR text spells out the difference.
- The reserved tag prefix `pack:*` is a new global invariant. The schema refinement that enforces "non-pack-install writes cannot use `pack:` tags" has to land everywhere users write tags (`memory.write`, `memory.write_many`, `memory.extract`, dashboard mutations). This is one refinement plus tests, not a sprawl.
- URL fetch introduces a network dependency. Off-line installs still work for the bundled path and `--from-file`; URL fetch is opt-in per invocation and gated by a config key. Operators in restricted environments flip `packs.allowRemoteUrls` to `false`.
- Two new top-level concepts in the public surface: `pack` (the artefact) and the `packs.*` command namespace. The cost is one ADR and the documentation guide; the user-visible benefit is the entire feature.
- One new top-level dependency on `@psraghuveer/memento-core`: the `yaml` package (eemeli/yaml, MIT, ~150 KB minified, pure JS, no transitive deps). Chosen over `js-yaml` because it supports YAML 1.2, has line-aware parse errors, and is the more actively maintained option. The dependency is required for both the parse path (install/preview) and the stringify path (export); adopting both directions through one library is simpler than splitting them.

### Risks

- **Pack author trust.** A user installing `--from-url` a community pack runs that pack's content through their assistant. The standard scrubber re-runs on every memory at install — same defence as `memento import` ([ADR-0019](0019-import-re-stamp-policy.md) §re-scrub). The threat model assumes the user has reviewed the YAML before install (HTTPS URLs are GET-able, so review is friction-free); we deliberately do *not* add cryptographic signatures in v1 (Alternative E).
- **Reserved-tag bypass.** A bug in the write context's source-flag plumbing could let user-authored writes use `pack:` tags. Mitigation: the schema refinement is the single point of enforcement, covered by direct tests and indirectly by every pack-install integration test that rejects a non-pack-install write of a reserved tag.
- **URL fetch as exfiltration vector.** A user tricked into running `memento pack install --from-url <attacker-url>` could install attacker-authored memories. Same defence as above (scrubber, re-stamp, content visible in the YAML the user can review). Plus the size/timeout caps stop denial-of-service via large bodies. We do not (yet) need to gate the flag behind an extra confirmation prompt; the size/timeout limits and review-before-install posture are sufficient for v1.
- **Pack ecosystem coordination.** With no central registry, two contributors could pick the same `id`. The bundled directory's repository is the de facto authority for "official" ids; community ids collide at install time and the user picks. We accept this as a v1 cost (npm went through the same in its earliest days) and revisit only if it becomes a real problem.

## Alternatives considered

### Alternative A: Reuse `memento-export/v1` JSONL as the pack format

- **Description.** Define a pack as a JSONL artefact in the existing portability format. Authors hand-write JSON lines with synthetic ULIDs and event chains; install is just `memento import` with a few extra flags.
- **Why attractive.** Zero new format. Re-uses every byte of the import path including [ADR-0019](0019-import-re-stamp-policy.md) machinery. One mental model.
- **Why rejected.** Authoring JSONL by hand is hostile UX. The format requires synthetic ids the author has to mint, fabricated event timestamps, and a footer SHA over the body. None of those are meaningful for hand-curated content; all of them are friction. The mismatch between "wire format" and "authoring format" is real, and the right answer is to acknowledge that two formats serve two purposes. JSONL stays the right answer for round-tripping a real store; YAML is the right answer for hand-authored bundles.

### Alternative B: Use existing assistant-rules formats (`.cursor/rules/`, `.windsurfrules`, etc.)

- **Description.** Adopt one of the assistant-rules formats already in the wild. Users author rules in their tool's native format; Memento parses and writes memories.
- **Why attractive.** Zero new format. Plugs into ecosystems users are already in.
- **Why rejected.** Those formats encode prompts, not durable memories. They lack kind discrimination (preference vs decision vs snippet), scope, decay metadata, and rationale-as-distinct-field. They are also tool-specific (Cursor's format is not Windsurf's); adopting one anoints a competitor. The right move is to support *importing* from those formats as a future feature (a `memento init` source scanner per the original GTM brief), but the pack format itself must be Memento-shaped.

### Alternative C: Add a `pack` MemoryKind

- **Description.** Make every pack-installed memory a new kind, e.g. `pack-fact`, `pack-decision`. The kind itself encodes provenance.
- **Why attractive.** Provenance is first-class without tags. Filtering "show me everything from packs" is a kind filter.
- **Why rejected.** Packs are a *delivery mechanism*, not a memory type. The decay, retrieval, and conflict policies for a pack-installed `fact` are identical to a hand-authored `fact`. Adding new kinds for delivery would require duplicating those policies (Rule 7) for no behavioural gain. Tags are the right axis: they describe *how* a memory got there, not *what kind of thing* it is.

### Alternative D: Central pack registry server

- **Description.** Stand up a registry like npm — a server with `pack publish`, search, install, version pinning, dependency resolution.
- **Why attractive.** Discovery is built in. A `memento pack search rust` lists everything available.
- **Why rejected.** Violates the local-first posture. Server costs (infra, abuse handling, takedowns, sign-in flow). All v1 needs are met by a GitHub repo + raw URLs. If discovery becomes a real problem, a future ADR can propose a federated index — not a centralised registry.

### Alternative E: Cryptographically signed packs

- **Description.** Require packs to carry a signature; the importer verifies against a key the operator has explicitly trusted.
- **Why attractive.** Closes the "untrusted YAML" attack vector at the source.
- **Why rejected.** Out of scope for v1. No user has asked for it; key management is a substantial new surface; the scrubber + re-stamp + review-the-YAML-before-install posture is sufficient at the local-first scale we operate at. Defer to a future ADR if cross-organisation pack sharing becomes a real workflow.

### Alternative F: Lifecycle command, not registry command

- **Description.** Make `pack install` purely a CLI lifecycle command, like `memento export` and `memento import`. No registry surface, no MCP exposure.
- **Why attractive.** Less surface. No dashboard concern.
- **Why rejected.** Assistants legitimately need to call `pack list` and `pack preview` — answering "which packs are installed in this store?" and "what would this pack add?" is exactly the kind of context an assistant uses to reason about the user's workflow. `pack install` and `pack uninstall` are also reasonable for the assistant to propose ("you might want `memento pack install rust-axum` based on your Cargo.toml"). Registry commands per [ADR-0003](0003-single-command-registry.md) is the right home; CLI lifecycle wraps for IO.

## Validation against the four principles

1. **First principles.** Cold-start kills retention; existing mechanisms ([ADR-0013](0013-portable-export-import.md), [ADR-0016](0016-assisted-extraction-and-context-injection.md), `memento init`) each solve a different problem. Packs exist because hand-authored, kind-discriminated, tag-provenanced bundles are the smallest construct that closes the cold-start gap without re-purposing a tool built for something else. YAML is chosen because authoring multi-line memory content is the load-bearing use case.
2. **Modular.** Parser, resolvers (bundled / file / URL), version-check, and install-as-pure-function are independent modules. The install function is a pure transformation from `PackManifest` to `MemoryWriteInput[]`; the registry command composes it with `memory.write_many`. Replacing the resolver layer (e.g., adding a `GitHubReleaseResolver` later) costs one module. Replacing the format (YAML → something else) costs one parser. The dashboard is a third adapter on the same registry per [ADR-0018](0018-dashboard-package.md), not a parallel surface.
3. **Extensible.** `format: memento-pack/v1` is the version negotiation point. Future v1.x additions (`config:` for config-key seeding, `embeddings:` for pre-computed vectors, `requires:` for cross-pack dependencies) are additive — v1 readers warn-and-skip unknown top-level keys, the same posture as `memento import`'s schema-version-skew handling. New `MemoryKind` variants flow through with zero pack-system changes; the manifest's `memories[].kind` is a discriminated union over the same `MEMORY_KIND_TYPES` constant the rest of the engine consumes.
4. **Config-driven.** Five `ConfigKey`s carry safety policy: `packs.bundledRegistryPath`, `packs.allowRemoteUrls`, `packs.urlFetchTimeoutMs`, `packs.maxPackSizeBytes`, `packs.maxMemoriesPerPack`. The integrity rules — owner re-stamp, scrubber on install, refuse-on-content-drift, reserved `pack:*` tag prefix, deterministic clientToken — are hardcoded invariants per Rule 12. Configurable invariants are no invariants.

## References

- [ADR-0003](0003-single-command-registry.md) — single command registry; pack commands live there.
- [ADR-0013](0013-portable-export-import.md) — wire format we deliberately did not adopt as authoring format.
- [ADR-0014](0014-bulk-destructive-operations.md) — dry-run-default + confirm gate inherited by `pack.uninstall`.
- [ADR-0016](0016-assisted-extraction-and-context-injection.md) — extraction compounds with packs once the store is seeded.
- [ADR-0018](0018-dashboard-package.md) — dashboard as third adapter on the registry.
- [ADR-0019](0019-import-re-stamp-policy.md) — re-stamp / re-scrub semantic model packs follow.
- [AGENTS.md](../../AGENTS.md) rules 4 (OwnerRef), 11 (audit log), 12 (configurable invariants are no invariants).
