# ADR-0026: MCP `instructions` as the session-teaching spine

- **Status:** Accepted
- **Date:** 2026-05-17
- **Deciders:** Raghu + Claude
- **Tags:** mcp, adoption, onboarding, server, instructions

## Context

Memento's tools work the moment a client connects. The harder problem is teaching the assistant *when* to call them — when to load context at session start, when to write, when to confirm, when to supersede, when to surface a conflict. Today that teaching lives in two out-of-band surfaces:

1. **The bundled skill** ([`skills/memento/SKILL.md`](../../skills/memento/SKILL.md)). Loaded by clients that honour Anthropic-format skills (Claude Code, Claude Desktop, a few others). The skill is intent-triggered — its YAML `description` frontmatter is matched against the user's message, and only matching sessions load it. A session that starts neutral ("help me fix this bug") never trips the trigger, so the assistant never calls `get_memory_context`, and pinned preferences stay invisible.

2. **The persona snippet** ([`docs/guides/teach-your-assistant.md`](../guides/teach-your-assistant.md)). Manual copy-paste into the client's persona file (`CLAUDE.md`, `.cursorrules`, etc.). Drifts from the server's actual capabilities, fails silently when the user skips the paste step, and trips the deferred-tool race on clients that lazy-load MCP tool schemas (a prescriptive `call write_memory` in the persona can fire before the schema is loaded).

Both surfaces require the user to do something *after* `memento init`. Both fail open: skip them and Memento is dead weight, the store stays empty, the assistant never re-asks for what it learned yesterday.

The Model Context Protocol provides a third surface we have not used: the `instructions` field on the `initialize` response. Servers return a string at handshake time; clients that honour the field inject it into the assistant's system prompt verbatim. The field is *optional* on the client side — the MCP TypeScript SDK we already depend on ([`@modelcontextprotocol/sdk@1.29`](../../node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@3.25.76/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.d.ts)) exposes it as `ServerOptions.instructions`, but implementations choose whether to surface it. Post-launch observation: Claude Code and Claude Desktop honour the field; Claude Chat at `claude.ai` web does not (silently drops it). Other clients are untested. We pass `{ name, version, capabilities }` to the `Server` constructor and leave `instructions` unset — closing the only in-band channel a server has to teach its client (for the subset that honours it).

## Decision

`buildMementoServer` emits a server-owned, version-stamped `instructions` string at handshake. Clients that honour the field see it injected into the assistant's system prompt at session start, regardless of skill support, regardless of whether a persona file is configured. Clients that ignore the field fall back to schema-embedded session-start hints (the per-tool descriptions) plus the persona snippet the user can paste into a custom-instructions slot. The spine is therefore **best-effort, not a guarantee** — but it's a free win on every client that does honour it, and there's no downside to emitting it for clients that don't (the field is silently dropped, not an error).

The body is a tight spine — roughly 60 lines — drawn from the same source the skill is built on, but limited to the **session-start contract** rather than the full distillation curriculum:

- Two session-start calls: `info_system` (to learn the user's `preferredName`) and `get_memory_context` (to load relevant memories with no query).
- The silent-plumbing rule: do not narrate memory operations; speak only when the user asked, a conflict surfaced, or the user said "remember this."
- The confirmation rule: call `confirm_memory` only on memories actually used.
- The write/extract shape note: both use a nested `kind` discriminated union (per [ADR-0027](0027-unified-memory-write-extract-surface.md)) — one shape to learn.
- The `topic: value` first-line rule for `preference` / `decision` writes, with a note that the server rejects offending writes via `safety.requireTopicLine` (default true).
- Supersede-not-update for content changes.
- Never write secrets.
- A pointer to the skill / persona snippet for deeper distillation rules.

The spine is exported as a public constant `MEMENTO_INSTRUCTIONS` from `@psraghuveer/memento-server` so contributors can read it without grepping for the inline string, and so tests can assert against a single source of truth. `buildMementoServer` reads it lazily — operators who want to override (e.g. embed an organization-specific addendum) can pass `info.instructions` to override entirely, or use it as the prefix and append their own text.

The skill remains the deeper-load surface: when the user's first message trips its frontmatter trigger, the skill loads the full distillation curriculum (precursor-action capture, named-participant attribution, the dated-event rule, the kind / scope decision trees). The spine carries what every session needs; the skill carries what some sessions need.

The persona snippet becomes the explicit fallback for the rare client that honours neither field nor skill. The guide is rewritten to position the three surfaces as a single hierarchy: `instructions` (every client, every session) → skill (Anthropic-format clients, intent-triggered) → persona snippet (manual paste, last resort).

## Consequences

### Positive

- Every MCP client that honours the optional `instructions` field now teaches its assistant at session start, with no user action beyond pasting the MCP config snippet. Clients that don't honour the field are no worse off than before.
- The teaching ships with the server, so it cannot drift from the actual tool surface — adding a tool with a new shape updates `MEMENTO_INSTRUCTIONS` in the same PR.
- Skills become enrichment rather than load-bearing baseline. Clients that don't support skills no longer fall to the persona snippet as their only teaching surface.
- The "first tool call errors" failure mode (persona prescribes a call before tool schemas are loaded) goes away — the spine recommends discovery-first calls (`info_system`, `get_memory_context`) that are part of the SDK-bundled schema set every client loads upfront.
- The spine is auditable in one file (`@psraghuveer/memento-server`'s exported constant) rather than scattered across persona-snippet docs.

### Negative

- Every connect emits ~60 lines into the assistant's system prompt. For clients with tight system-prompt budgets, this is non-zero context cost. Mitigation: the spine is deliberately short; the skill (load-on-intent) carries the long-form rules.
- Three teaching surfaces now exist (`instructions`, skill, persona). The hierarchy is explicit and documented, but contributors need to know which surface a given rule belongs in. Rule of thumb encoded in the contributor docs: spine = session-start contract; skill = distillation craft; persona = last-resort mirror.

### Risks

- Spine drifts from the skill — the same rule worded two different ways causes assistant confusion. Mitigation: a unit test asserts that the spine's core rules (silent plumbing, confirm only what you use, supersede not update, topic-line, no secrets) appear verbatim in the skill, or the test fails with a pointer to the file pair to reconcile.
- Operators want to override the spine but lose the canonical content. Mitigation: `MEMENTO_INSTRUCTIONS` is exported, so an operator's custom string can prepend or append the canonical spine via string concatenation.
- Clients that ignore `instructions` silently lose the teaching. Mitigation: those same clients are the ones that benefit most from the skill / persona snippet — the existing fallbacks are unchanged.

## Alternatives considered

### Alternative A: keep the status quo (skill + persona only)

- Attractive: no protocol surface change; behavior is fully client-controlled.
- Rejected: the failure modes documented above (skill doesn't fire every session, persona drifts, manual paste step) are the dominant adoption blocker. Both fallbacks are out-of-band; we have an in-band channel and not using it is a choice.

### Alternative B: emit `instructions` as a docs link only

- Body says "see https://memento.dev/skill for usage rules", nothing more.
- Attractive: smallest possible payload.
- Rejected: assistants can't fetch URLs at session start in most client configurations, and the URL would be one-more-thing-to-keep-current. The point of the field is in-band teaching; a link defeats it.

### Alternative C: full skill content (~270 lines) inlined

- Attractive: maximum reach; one surface to maintain.
- Rejected: blows the system-prompt budget on every connect, and most of the skill is distillation craft that does not need to load until the assistant is actually writing. The session-start contract is a strict subset; teaching it twice (in `instructions` and the skill on intent) is fine because the spine intentionally omits the long-form rules.

### Alternative D: prompts (`session-context`) instead of `instructions`

- Memento already exposes a `session-context` MCP prompt that runs `get_memory_context` and returns the result as a user-role message. Some clients render prompts as slash commands.
- Attractive: leverages an existing surface.
- Rejected: prompts are user-invoked, not auto-loaded. They are an *adjacent* surface (good for explicit `/session-context` calls in Claude Desktop) but do not solve the teaching problem — the assistant still needs to know to *call* the prompt.

## Validation against the four principles

1. **First principles.** The MCP spec defines a server→client teaching channel; we proved we need teaching (the persona-snippet + skill combination is documented evidence). Using the spec's channel is the simplest correct design.
2. **Modular.** The spine is exported as a constant; a future surface (HTTP transport, custom hosts) reads the same constant. Operators can override per-server via `info.instructions`.
3. **Extensible.** New surfaces (a future "MCP capabilities introspection" hint, an organization addendum) extend the spine by replacement at the operator boundary; the canonical content is one read away.
4. **Config-driven.** The spine content itself is not a runtime config knob (it's the server's authoritative teaching), but operators can override per-server via the `info.instructions` constructor option — the standard escape hatch for default-with-override behavior.

## References

- ADR-0003: Single command registry → MCP and CLI as adapters (the spine teaches assistants about the same registry both surfaces project).
- ADR-0016: Assisted extraction and context injection (this ADR closes the adoption gap ADR-0016 named — assistants now know to call `get_memory_context` at session start because the server tells them to).
- ADR-0027: Unified `memory.write` / `memory.extract` surface (the spine teaches the nested `kind` shape ADR-0027 standardises).
- MCP specification — `initialize` response `instructions` field.
- [`@modelcontextprotocol/sdk`](../../node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_zod@3.25.76/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.d.ts) — `ServerOptions.instructions`.
