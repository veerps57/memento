---
'@psraghuveer/memento': patch
'@psraghuveer/memento-server': patch
---

docs: calibrate claims about MCP `instructions` field reach

Post-launch testing surfaced that the MCP `instructions` field (ADR-0026) is optional on the client side, and not every client honours it. Observed today: Claude Code and Claude Desktop inject the spine into the assistant's system prompt; Claude Chat at `claude.ai` web silently drops it. Other clients (Cursor, VS Code Agent, OpenCode, Cline) are untested.

The pre-launch docs overstated the reach — phrases like *"every spec-compliant client injects this verbatim with no user action"* implied universal coverage that doesn't match the observed reality. This patch revises every overstated passage in:

- Root `README.md`, `packages/cli/README.md`, `packages/server/README.md`
- `docs/guides/teach-your-assistant.md` (added a per-client support matrix and a disambiguating test users can run themselves)
- `packages/landing/src/App.tsx` + `howto.ts`
- `docs/adr/0026-mcp-instructions-as-session-teaching-spine.md` (prose only; the decision is unchanged)

The framing now is:

- **Spine** = best-effort; works in clients that honour the field, silently dropped elsewhere.
- **Skill** = load-bearing for Anthropic-format-skill clients (Claude Code, Claude Desktop).
- **Persona snippet** = the **universal fallback** that the user pastes into the client's custom-instructions slot to guarantee the contract reaches their assistant.

No code change. No behaviour change. Strictly docs honesty.
