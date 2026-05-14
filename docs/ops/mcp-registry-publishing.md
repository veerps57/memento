# MCP Registry publishing

Maintainer playbook for publishing Memento to the official MCP Registry as `com.runmemento/memento`. Covers the steady-state pipeline, the first-publish procedure (one-time), key rotation (rare), and pinned-binary bumps. Decision and rationale: [ADR-0022](../adr/0022-mcp-registry-publishing.md).

## How the pipeline works

A normal release proceeds in this order:

1. The "Version Packages" changesets PR merges to `main`.
2. [`release.yml`](../../.github/workflows/release.yml) builds and runs `pnpm release`, which calls `changeset publish` and pushes per-package npm versions.
3. If the CLI package (`@psraghuveer/memento`) was part of the release, `release.yml` then pushes the umbrella `vX.Y.Z` tag keyed off `packages/cli/package.json.version`.
4. When the Release workflow completes successfully, [`mcp-registry-publish.yml`](../../.github/workflows/mcp-registry-publish.yml) fires via `workflow_run`, finds the umbrella `v*` tag at the head commit, verifies it matches the `version` field in `server.json`, downloads and checksums `mcp-publisher`, authenticates against the registry via DNS (Ed25519 signing key on the apex of `runmemento.com`), and runs `mcp-publisher publish`.

We use `workflow_run` rather than `on: push: tags: ["v*"]` because GitHub Actions suppresses downstream workflows when the trigger event is fired by `GITHUB_TOKEN` — a recursion guard. The Release workflow pushes the umbrella tag with the default token, so a `push: tags` trigger would never fire. The `workflow_run` event sidesteps the suppression cleanly.

If the Release workflow ran but didn't push an umbrella tag (because only non-CLI packages bumped — e.g. just `@psraghuveer/memento-core`), the registry workflow detects no `v*` tag at HEAD and exits cleanly without publishing. The MCP registry only tracks the CLI tarball, so non-CLI releases need no registry update.

To verify a publish succeeded:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=com.runmemento" | jq '.servers[0]["server"]["version"]'
```

Manual recovery: re-run `mcp-registry-publish.yml` with `workflow_dispatch` and supply the tag (`vX.Y.Z`). Useful after a transient registry or DNS-resolver failure.

## Downstream listings

The official registry is the canonical upstream. Smithery, Glama, mcpfinder, PulseMCP, and mcp.so mirror its entries within ~24h. After a fresh major release scan those surfaces and:

- Claim the auto-generated Smithery listing at `smithery.ai/server/com.runmemento/memento` and add the install snippet.
- Claim the Glama listing at `glama.ai/mcp/servers/com.runmemento/memento`.
- The other indexers require no maintainer action beyond the canonical publish.

## First publish (one-time)

Executed once when ADR-0022 landed. Captured here for the next maintainer who needs to bootstrap a fresh namespace or recover from a complete identity loss.

1. **Generate an Ed25519 keypair.** From a directory outside the repo (so accidental commits are impossible):

   ```bash
   mkdir -p ~/secrets/memento && cd ~/secrets/memento
   openssl genpkey -algorithm Ed25519 -out memento-mcp-registry.pem
   chmod 600 memento-mcp-registry.pem
   ```

   If system `openssl` doesn't support Ed25519 (LibreSSL on older macOS), `brew install openssl@3` and reference `$(brew --prefix openssl@3)/bin/openssl` instead. **Back up the PEM to a password manager immediately** — the hex private key (next step) is a one-way export; losing the PEM and the GitHub secret simultaneously forces a rotation.

2. **Extract the hex private key (for the GitHub Secret) and the base64 public key (for the DNS TXT record):**

   ```bash
   PRIV_HEX=$(openssl pkey -in memento-mcp-registry.pem -outform DER | tail -c 32 | xxd -p -c 64)
   PUB_B64=$(openssl pkey -in memento-mcp-registry.pem -pubout -outform DER | tail -c 32 | base64)
   ```

   `PRIV_HEX` is 64 hex chars; `PUB_B64` is 44 chars ending in `=`. Sanity-check: `echo -n "$PUB_B64" | base64 -d | wc -c` prints `32`.

3. **Add a TXT record on the apex of `runmemento.com`:**

   | Field | Value |
   |---|---|
   | Type | `TXT` |
   | Host | `@` (apex; not `_mcp.` or any subdomain) |
   | Value | `v=MCPv1; k=ed25519; p=<PUB_B64>` |
   | TTL | 300 |

   Verify propagation: `dig +short TXT runmemento.com @1.1.1.1` and `dig +short TXT runmemento.com @8.8.8.8` must both return the record.

4. **Store the hex private key as a GitHub Actions secret on the repo:**

   ```bash
   gh secret set MCP_PRIVATE_KEY --repo veerps57/memento
   # paste PRIV_HEX, then Ctrl+D
   gh secret list --repo veerps57/memento | grep MCP_PRIVATE_KEY
   ```

5. **First publish from your laptop** after DNS propagates:

   ```bash
   brew install mcp-publisher    # macOS; or download the pinned binary from upstream releases

   cd /path/to/memento
   mcp-publisher login dns --domain runmemento.com --private-key "$PRIV_HEX"
   mcp-publisher publish
   ```

   The registry entry is live at `https://registry.modelcontextprotocol.io/v0.1/servers/com.runmemento%2Fmemento/versions`. Subsequent releases publish automatically via [`mcp-registry-publish.yml`](../../.github/workflows/mcp-registry-publish.yml).

## Key rotation

Rotate when:

- the laptop or password manager holding the PEM is lost or compromised,
- the `MCP_PRIVATE_KEY` GitHub Secret leaks,
- it's been ~2 years since the last rotation (hygiene).

**Order matters.** The registry tries TXT records on the apex sequentially; a stale record left behind takes the first slot and fails verification before the new one is reached.

1. Generate a new keypair (steps 1–2 of the first-publish procedure above, with a different filename).
2. **Add the new TXT record alongside the existing one.** Both records briefly coexist on the apex.
3. Wait for DNS propagation — `dig +short TXT runmemento.com @1.1.1.1 @8.8.8.8` must show both records globally.
4. **Remove the old TXT record.** Verify again with `dig`; only the new record should appear.
5. Update the `MCP_PRIVATE_KEY` GitHub Secret with the new hex.
6. **Validate via `workflow_dispatch`** — re-run `mcp-registry-publish.yml` against the latest published tag. The registry rejects the duplicate version, but the failure happens *after* DNS auth, so a clean failure on the publish step proves the new key works.
7. Back up the new PEM to your password manager. Shred the old PEM. Remove the old public-key value from any notes.

## Bumping the pinned mcp-publisher binary

[`mcp-registry-publish.yml`](../../.github/workflows/mcp-registry-publish.yml) pins both the binary version and its SHA-256:

```yaml
env:
  MCP_PUBLISHER_VERSION: "v1.7.9"
  MCP_PUBLISHER_SHA256: "ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac"
  MCP_PUBLISHER_ARCHIVE: "mcp-publisher_linux_amd64.tar.gz"
```

To upgrade:

```bash
gh release view --repo modelcontextprotocol/registry --json tagName,assets \
  | jq '{tag: .tagName, sha: (.assets[] | select(.name=="mcp-publisher_linux_amd64.tar.gz") | .digest)}'
```

Copy the new `tag` into `MCP_PUBLISHER_VERSION` and the `digest`'s `sha256:` suffix into `MCP_PUBLISHER_SHA256`. Open a PR. CI exercises the new pin on the next release.

Skim the upstream changelog for breaking flag changes (`mcp-publisher login dns` syntax, `publish` defaults) before bumping.

## Troubleshooting

- **Workflow's `login dns` step fails with "TXT not found" while local `dig` succeeds.** GitHub Actions runners use public resolvers; check via `dig @1.1.1.1` and `@8.8.8.8`, not your ISP's resolver.
- **`login dns` succeeds but `publish` fails with "name does not match tarball".** The `mcpName` field in `packages/cli/package.json` drifted from the `name` field in `server.json`. `pnpm server-json:check` catches this locally; CI's `verify` chain catches it on every PR.
- **Workflow refuses to publish with "Tag X does not match server.json version Y".** Someone hand-pushed a `v*` tag bypassing the `version-packages` script. Don't bypass — let changesets bump the CLI version and let `release.yml` push the umbrella tag.
- **`mcp-publisher --version` shows an unexpected version.** The pinned `MCP_PUBLISHER_VERSION` got out of sync with `MCP_PUBLISHER_SHA256` (e.g. a partial PR). Cross-check via `gh release view` as above.
- **Multiple stale TXT records on the apex after a rotation.** Remove all but the current one. Each lingers across resolver caches for up to the TTL; lowering the TTL to 60 before a rotation shortens the window.
