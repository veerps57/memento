---
'@psraghuveer/memento': minor
'@psraghuveer/memento-server': patch
---

feat(cli): auto-install the persona snippet into detected clients; client-neutral docs reframe

Two coupled changes shipping together. The reframe (docs + init walkthrough) acknowledges what testing showed — the MCP `instructions` field (ADR-0026) is optional on the client side and current implementations typically don't surface it to the assistant's system prompt. The new auto-installer collapses the manual "paste this into your client's custom-instructions slot" step into a `y/N` during `memento init` for the subset of clients whose persona slot is a file on disk.

**Auto-installer (new `packages/cli/src/persona-installer.ts`)**

A fourth interactive prompt in `memento init` offers to write the persona snippet — sourced from the same `MEMENTO_INSTRUCTIONS` constant the MCP server emits — into every detected file-based client's user-scope custom-instructions file. UI-only clients (Cowork, Claude Desktop, Claude Chat, Cursor User Rules) surface as copy-paste instructions in the renderer.

Detected targets, by canonical user-scope path:

- Claude Code → `~/.claude/CLAUDE.md` (loaded into every session per Anthropic's docs)
- OpenCode → `~/.config/opencode/AGENTS.md`
- Cline → `~/Documents/Cline/Rules/memento.md`

Each write is wrapped in HTML-comment markers (`<!-- memento:persona BEGIN v<version> -->` / `<!-- memento:persona END -->`), making the install:

- **Idempotent.** Re-running `init` with identical content reports `already-current` and no-ops the write.
- **Updatable in place.** Re-running with new content splices the block out and rewrites — no accumulated drift, no duplicate blocks.
- **Removable.** The marker bounds let a future `memento persona uninstall` strip the block while leaving surrounding user content intact.

Detection is filesystem-only — no network calls. A client whose canonical directory doesn't exist on the host is simply skipped (no write, no spurious "if you also use X…" line). The persona content itself reuses `MEMENTO_INSTRUCTIONS` exported from `@psraghuveer/memento-server` so the spine on the wire and the persona on disk never drift.

The prompt defaults to `Y` and presents an explicit per-target enumeration before asking for consent — the user sees exactly which files will be written and which UI surfaces still need manual paste before confirming.

**Docs + walkthrough reframe (client-neutral)**

Every user-facing doc reordered into reliability order — persona first, skill second, spine third — with all client-specific honours/doesn't claims removed. The framing now is:

- **Persona snippet** = universal, always-on. The only teaching surface guaranteed to land in every client. **Now optionally auto-installed** during `memento init` for file-based clients.
- **Bundled skill** = load-on-intent enrichment for skill-capable clients.
- **MCP `instructions` spine** = best-effort future-proofing on the wire. Optional on the client side; implementations vary.

Files touched (docs + init prose):

- Root `README.md`, `packages/cli/README.md`, `packages/server/README.md` — three-step quickstart; spine framed as best-effort future-proofing.
- `docs/guides/teach-your-assistant.md` — surfaces reordered into reliability order; the per-client honours/doesn't matrix removed in favour of neutral single-paragraph framing per surface.
- `packages/landing/src/App.tsx` + `howto.ts` — quickstart grid expands to three cards; persona snippet block re-titled "the universal always-on teaching surface".
- `docs/adr/0026-mcp-instructions-as-session-teaching-spine.md` — prose updates; the decision is unchanged. ADR-immutability protects the decision, not the wording.
- `packages/cli/src/init-render.ts` — Step 3 now opens with the universal persona recommendation; per-target persona-install outcomes render below the existing skill / pack ack block.

Language is client-neutral throughout — no surface is labelled by which specific clients honour it.

**Bump rationale**

- `@psraghuveer/memento` (CLI): **minor** — coherent feature addition (auto-installer) on top of the docs sweep.
- `@psraghuveer/memento-server`: **patch** — docs-only changes; no behaviour change.

`pnpm verify` clean. **1612 tests passing** across 118 files (+12 new persona-installer tests on top of the 1600 baseline).
