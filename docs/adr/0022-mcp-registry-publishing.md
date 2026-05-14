# ADR-0022: Publishing to the official MCP Registry

- **Status:** Proposed
- **Date:** 2026-05-14
- **Deciders:** Memento Authors
- **Tags:** distribution, registry, ci-cd, publishing

## Context

Memento has shipped on npm as [`@psraghuveer/memento`](https://www.npmjs.com/package/@psraghuveer/memento) since 0.1.0, and users wire it up by pasting the `npx @psraghuveer/memento serve` snippet `memento init` prints into their MCP client config. That works for users who already know Memento exists. It does not work for the much larger population of MCP-capable-assistant users who go looking for "memory for Claude / Cursor / Cline" and start from a discovery surface — the official MCP Registry, the `modelcontextprotocol/servers` GitHub list, Smithery, Glama, PulseMCP, mcp.so, mcpfinder. We are absent from all of them.

The official MCP Registry at [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) is the canonical upstream. Smithery, Glama, mcpfinder, and the secondary indexers mirror its entries; listing once propagates everywhere downstream. The registry requires a [`server.json`](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md) manifest and proof that the publisher owns the namespace they are claiming.

The namespace choice has long-term consequences. Three options exist:

1. **`io.github.veerps57/memento`** — authenticated via GitHub OIDC, no DNS. Fastest path. Ties the registry identity to a personal GitHub username that may not survive a rename, a transfer to an organization account, or a move to a different host.
2. **`com.runmemento/memento`** — authenticated via DNS TXT on the apex of `runmemento.com`. Brand-stable, matches the domain already named in every package's `homepage` field and the canonical landing site. Costs a persistent TXT record and a private key stored as a GitHub Actions secret.
3. **Reserved namespaces (`io.modelcontextprotocol/...`, `com.anthropic/...`)** — not available to third-party servers.

The publishing surface is similarly constrained. Three failure modes drive the design:

- **Drift between npm releases and the registry listing.** Manual publishing means every release becomes "did we remember to update the registry?" The registry copy gradually falls behind the npm copy. AGENTS.md treats this class of drift seriously elsewhere (auto-generated reference docs, the version-packages flow) and the same logic applies here: state changes that can drift should be automated, not remembered.
- **Version sync between `server.json` and `packages/cli/package.json`.** The registry rejects a publish whose `server.json.version` doesn't match the npm tarball's `package.json.version`. Two committed sources of truth for the same string is exactly the configuration anti-pattern the project avoids elsewhere.
- **Authentication key durability.** A lost private key means rotating both the GitHub Secret and the DNS TXT record. Without a documented runbook, recovery is improvisation under pressure.

## Decision

We publish Memento to the official MCP Registry as **`com.runmemento/memento`**, authenticated via DNS TXT on the apex of `runmemento.com`. A `server.json` manifest lives at the repo root with `name = com.runmemento/memento`, `version` mirroring `packages/cli/package.json`, and a single `packages[]` entry pointing at the npm tarball with `transport.type = "stdio"`. The [packages/cli/package.json](../../packages/cli/package.json) file gains an `mcpName: "com.runmemento/memento"` field — the registry verifies on publish that the npm tarball's `mcpName` matches the manifest's `name`, proving the package belongs to this server entry.

Version sync between `server.json` and `packages/cli/package.json` is enforced at version-bump time: the root [package.json](../../package.json) `version-packages` script invokes a new `scripts/sync-server-json-version.mjs` that reads the freshly-bumped CLI version and rewrites both `server.json.version` and `server.json.packages[0].version` before Biome formats the result. A CI gate fails the build if the two versions diverge on `main` — defense in depth against any path that updates the CLI version without going through changesets.

Publishing is automated. A new GitHub Actions workflow `.github/workflows/mcp-registry-publish.yml` triggers on the `v*` umbrella tag the existing [release.yml](../../.github/workflows/release.yml) pushes after every successful `changeset publish`. The workflow downloads a pinned `mcp-publisher` Go binary (release tag + SHA-256 both pinned), authenticates with `mcp-publisher login dns --domain runmemento.com --private-key "$MCP_PRIVATE_KEY"`, and runs `mcp-publisher publish`. The `MCP_PRIVATE_KEY` GitHub Actions secret holds the hex-encoded raw 32-byte Ed25519 seed; the matching public key sits in the apex TXT record as `v=MCPv1; k=ed25519; p=<base64-pubkey>`.

The first publish is performed manually from the maintainer's laptop after DNS propagation, before the CI workflow merges. This validates the keypair, the TXT record, and the namespace claim against the real registry before CI inherits the responsibility. The CI workflow is idempotent thereafter — publishing the same version twice is a no-op.

The Smithery, Glama, PulseMCP, mcp.so, and mcpfinder listings are operational follow-ups, not architectural decisions: Smithery and Glama auto-index from the official registry within ~24h and we claim the auto-generated listings; the rest are downstream mirrors of the official registry and require no action beyond the canonical publish.

## Consequences

**Positive:**

- Memento becomes discoverable on the canonical MCP discovery surface. A Cursor or Cline user searching for "memory" finds the registry entry, follows it to runmemento.com, and lands on a working install.
- Downstream indexers (Smithery, Glama, mcpfinder, PulseMCP, mcp.so) mirror the official registry — one canonical publish populates the entire discovery ecosystem with no per-surface maintenance.
- The `com.runmemento` namespace is brand-stable. It survives maintainer renames, organization migrations, and any future move off GitHub. The npm package name (`@psraghuveer/memento`) can independently evolve if the npm org changes; the registry identity is decoupled.
- Publishing is tied to the existing release tag, so registry listings cannot drift behind npm releases without a CI failure being visible.
- DNS-based auth means the signing key is independent of the maintainer's GitHub identity. Losing GitHub access doesn't lose publishing capability — the PEM in the password manager is sufficient to re-establish CI publishing on any new repo.

**Negative — accepted:**

- A persistent TXT record on the apex of `runmemento.com` and a private key in GitHub Secrets are new operational dependencies. The OIDC-on-`io.github.veerps57/*` path would have neither. We accept the cost because the namespace stability is worth more than the simplicity of OIDC, and the runbook makes rotation tractable.
- Key rotation is non-trivial: generate new keypair, add the new TXT (the registry tries records in order — the stale one must be removed first or verification fails), update `MCP_PRIVATE_KEY`. Publishing pauses during DNS propagation. The runbook in [docs/guides/operations.md](../../docs/guides/operations.md) documents the exact sequence.
- `server.json` is one more file to keep in version sync. We solve this with the version-packages sync script and a CI gate, treating it the same way the auto-generated `docs/reference/` files are treated — committed but mechanically derived.
- The `mcp-publisher` binary is downloaded at CI time from GitHub releases. A silent upstream change could break publishing without warning. We pin both the release tag and the SHA-256 of the binary to defend against this; pin updates flow through a normal PR with the new SHA recorded.

**Out of scope, deliberately:**

- **HTTP / SSE remote transport entries in `server.json`.** Memento is stdio-only per the local-first architecture. No `remotes` block.
- **Per-language SDK packages.** Memento ships as a single Node package; no Python, Go, or Rust variants.
- **Per-platform packaging (Homebrew formula, deb, snap).** Out of scope here; covered by separate distribution decisions if and when they arrive.
- **Hosted Memento on Smithery's runtime.** Memento needs local filesystem access for its SQLite database. Smithery's hosted runner is for stateless or remote-backed servers; we list as a local stdio server only.
- **A second namespace for organizational ownership.** The registry supports multiple manifests per package, but the maintainer is currently one individual. Revisit if and when an organization assumes maintainership.

## Alternatives considered

### `io.github.veerps57/memento` namespace, GitHub OIDC auth

Authenticate publishes with `mcp-publisher login github-oidc`, no DNS or GitHub secret required. Attractive because it is the shortest path from zero to listed: no openssl ceremony, no DNS provider tab, no key to lose. Rejected because the namespace identity is tied to a personal GitHub username. A rename, a move to a `@runmemento` organization account, or a migration off GitHub would all force a new namespace claim and break the canonical entry. The `com.runmemento` namespace decouples the registry identity from any single hosting provider — a one-time DNS cost in exchange for a stable identity.

### Skip the official registry, list on Smithery and Glama directly

Each downstream indexer supports manual submission. Attractive because it requires no `server.json`, no DNS, no Ed25519 key — just web forms. Rejected because Smithery, Glama, mcpfinder, and similar tools have all converged on mirroring the official registry as their primary ingestion path. Skipping the canonical upstream means maintaining N separate listings, each with its own update mechanism, each its own drift risk. The official registry is the one place a single publish reaches every downstream surface.

### HTTP-based namespace authentication instead of DNS

Host a well-known signed-token file at `https://runmemento.com/.well-known/mcp-registry-auth` and authenticate via `mcp-publisher login http`. Attractive because it sidesteps DNS providers entirely. Rejected because the landing site at runmemento.com is a static export from [packages/landing](../../packages/landing) deployed to GitHub Pages via [deploy-landing.yml](../../.github/workflows/deploy-landing.yml); adding a signed token means committing it to the repo, deploying through the landing workflow on every key rotation, and coupling publish cadence to landing-site infrastructure. DNS TXT records are the lightest persistent proof available and require no infrastructure changes beyond a DNS provider entry that already exists alongside the `google-site-verification` record.

### Manual publish only, no CI workflow

Run `mcp-publisher publish` from a maintainer's laptop after every release. Attractive because there's no private key in GitHub Secrets and the surface area shrinks. Rejected because it introduces exactly the npm-vs-registry drift this ADR exists to prevent. The manual flow remains documented as a recovery path (used for the first publish and for any post-incident catch-up), but the steady-state must be automated.

### Sync `server.json.version` in a CI step instead of at version-bump time

Have the registry-publish workflow `jq`-rewrite `server.json.version` from the tag's CLI version, leaving `server.json` perpetually pinned at `0.0.0` on `main`. Attractive because it removes one moving file from PRs. Rejected because the committed copy on `main` should reflect the most recently published state — if a contributor opens a PR and inspects `server.json`, they should see real numbers, not a placeholder. Coupling the sync to the changesets-driven version-packages script keeps `main` always-correct and isolates the publish workflow to the publish step alone.

## Validation against the four principles

1. **First principles.** The registry exists because Memento needs a discovery surface beyond the npm-and-GitHub-savvy crowd, and the official registry is the canonical entry point downstream indexers mirror. Listing there is the smallest move that delivers discovery across the entire MCP ecosystem.
2. **Modular.** The publishing surface is three isolated files (`server.json`, `scripts/sync-server-json-version.mjs`, `.github/workflows/mcp-registry-publish.yml`) and one field (`mcpName` in [packages/cli/package.json](../../packages/cli/package.json)). Removing them reverts to npm-only distribution without touching the engine. The auth method (DNS) is swappable for OIDC if the namespace ever changes; the npm tarball contract is unchanged either way.
3. **Extensible.** New transport types (HTTP, SSE) layer on as additional `packages[]` or `remotes[]` entries in `server.json`. New namespaces (e.g. a future `com.runmemento.team/...`) are additive — the registry supports multiple manifests per package owner.
4. **Config-driven.** Not applicable in the engine-config sense — `server.json` is static metadata, not runtime behavior, and adding a `ConfigKey` for it would conflate "what we ship" with "how we run." The principle governs engine behavior; distribution metadata is correctly hardcoded.

## Implementation summary

- New `server.json` at repo root, schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, name `com.runmemento/memento`, one `packages[]` entry with `transport.type = "stdio"`.
- New `mcpName: "com.runmemento/memento"` in [packages/cli/package.json](../../packages/cli/package.json).
- New `scripts/sync-server-json-version.mjs` invoked from the root [package.json](../../package.json)'s `version-packages` script — reads CLI version, writes `server.json.version` and `server.json.packages[0].version`, runs Biome format on the result.
- New CI gate in `pnpm verify` (or a small new `docs:check`-style script) that fails on `server.json.version != packages/cli/package.json.version`.
- New `.github/workflows/mcp-registry-publish.yml` triggered on `push: tags: ['v*']`, downloads a pinned `mcp-publisher` binary verified by SHA-256, authenticates via DNS, publishes.
- New operations-runbook section in [docs/guides/operations.md](../../docs/guides/operations.md) covering key rotation and first-publish procedure.
- README badge for the registry entry added after the first successful publish.

## References

- [Official MCP Registry](https://registry.modelcontextprotocol.io)
- [`server.json` schema reference](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)
- [Registry publishing quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
- [DNS authentication](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)
- [GitHub Actions integration](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx)
- [`modelcontextprotocol/servers` community list](https://github.com/modelcontextprotocol/servers)
- Related: [ADR-0003 — Single command registry](0003-single-command-registry.md). This ADR adds an external distribution surface that consumes from npm; it does not alter the engine-level command registry contract.
- Related: [ADR-0009 — Apache-2.0 license](0009-apache-2.0-license.md). License metadata flows from `packages/cli/package.json` into the registry entry.
