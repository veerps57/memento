---
'@psraghuveer/memento': patch
'@psraghuveer/memento-server': patch
---

docs: client-neutral calibration of teaching surfaces; persona-first three-step pitch

Post-launch testing across multiple MCP clients showed that the optional `instructions` field on the initialize response (ADR-0026) is typically not surfaced to the assistant's system prompt by current client implementations. The spine reaches the wire but rarely reaches the model. Separately, the bundled skill is intent-triggered by design — it doesn't fire on neutral first messages. The persona snippet (pasted into the client's custom-instructions slot) is therefore the only teaching surface guaranteed to land in the assistant's system prompt on every message.

This patch reframes every user-facing doc and the `init` walkthrough to match that reality. The framing is now **persona-first, skill-second, spine-third** — ordered by reliability of reach. Language is client-neutral throughout: no surface is labelled by which specific clients honour it, since client implementations vary and the per-client matrix drifts faster than docs.

**Files touched (docs + init prose only — no behaviour change):**

- Root `README.md`, `packages/cli/README.md`, `packages/server/README.md` — three-step quickstart (init → paste MCP snippet → paste persona snippet); explicit framing of the spine as best-effort future-proofing.
- `docs/guides/teach-your-assistant.md` — surfaces reordered into reliability order (persona first); the per-client honours/doesn't matrix is removed in favour of a neutral, single-paragraph framing per surface. The disambiguating test users can run on their own client stays.
- `packages/landing/src/App.tsx` + `howto.ts` — quickstart grid expands from two cards to three; persona snippet header re-titled as "the universal always-on teaching surface"; copy throughout reframed to avoid client-specific honours/doesn't claims.
- `docs/adr/0026-mcp-instructions-as-session-teaching-spine.md` — prose updates; the **decision is unchanged** (still emit the spine; still treat as future-proofing). Per the convention that ADR-immutability protects the decision, not the wording.
- `packages/cli/src/init-render.ts` — the rendered text walkthrough now opens Step 3 with a universal "paste the persona snippet" recommendation regardless of skill state; the skill section follows as on-intent enrichment for skill-capable clients. The persona-only legacy branch is removed because the universal recommendation always renders.

**The framing now is:**

- **Persona snippet** — universal, always-on. The only teaching surface guaranteed to reach the assistant on every message. The mandatory step for guaranteed behaviour.
- **Bundled skill** — load-on-intent enrichment for skill-capable clients. Layers richer distillation rules when memory-relevant intent is detected.
- **MCP `instructions` spine** — best-effort future-proofing on the wire. Optional on the client side; implementations vary in whether they surface it. Harmless when ignored, free win when honoured.

No code change beyond the init walkthrough's rendered prose. `pnpm verify` still passes (1600 tests / 117 files). Test fixtures asserting on the renderer's output are updated to match the new persona-first opening of Step 3.
