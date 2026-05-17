---
'@psraghuveer/memento': minor
'@psraghuveer/memento-server': minor
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-schema': minor
---

Onboarding revamp: spec-compliant session teaching, unified memory write surface, interactive `init`, and a new `verify-setup` command.

This is a coordinated 0→1 install-journey overhaul shipping across every published package.

**What's new**

- **MCP `instructions` on every connect** (ADR-0026). `buildMementoServer` now emits a ~60-line session-start teaching spine as part of the `initialize` handshake. Every spec-compliant MCP client injects it into the assistant's system prompt verbatim, so the contract — when to load context, when to write, when to confirm, the `topic: value` rule, the silent-plumbing rule, no secrets — is in place from the first message with no skill or persona-paste required. The canonical body is exported as `MEMENTO_INSTRUCTIONS` from `@psraghuveer/memento-server`; operators can override via `info.instructions`.
- **Unified `memory.write` / `memory.extract` candidate shape** (ADR-0027). Both surfaces now take the same discriminated-union `kind` object: `{"type":"fact"}`, `{"type":"preference"}`, `{"type":"decision","rationale":"..."}`, `{"type":"todo","due":null}`, `{"type":"snippet","language":"shell"}`. Per-kind fields (`rationale`, `language`) live inside the `kind` object, not as top-level siblings. **Breaking change to `memory.extract`** — callers that hand-construct extract payloads with the flat-`kind` shape (`{"kind":"fact","rationale":"..."}`) must migrate to nested form. The bundled packs and the skill ship with the new shape; the persona snippet is updated; the tool descriptions in `tools/list` spell it out.
- **Hybrid sync/async `memory.extract`**. New default `extraction.processing: 'auto'` runs sync for batches ≤ `extraction.syncThreshold` (default 10) and async above. The "empty-arrays receipt looks like a failure" UX is gone for typical session-end sweeps. The explicit `sync` and `async` overrides remain for operators with strict requirements.
- **Interactive `memento init`** (ADR-0028). On a TTY, `init` walks the user through three one-keystroke setup questions before printing the MCP snippets: their preferred display name (so memories read "Raghu prefers …" not "The user prefers …"), whether to install the bundled skill into `~/.claude/skills/`, and whether to seed the store with one of four starter packs. Pass `--no-prompt` to suppress the interactive flow (CI, scripts). The walkthrough text trims itself accordingly — sections whose work is done don't reappear as copy-paste instructions.
- **New `memento verify-setup` command** (ADR-0028). End-to-end MCP write/search/cleanup round-trip that proves your assistant can actually use Memento. Runs against the same engine surface `memento serve` exposes via an in-memory MCP transport — no subprocess spawn. Replaces the previous "ask the assistant something and see if it works" smoke test with a structured check sequence.

**Topic-line enforcement is now the documented default**. `safety.requireTopicLine` already defaulted to `true`; this PR ratifies the rule in the persona snippet, the skill, the spine, and the READMEs as binding rather than opt-in. Existing flag-flip (`safety.requireTopicLine: false`) remains for operators who want the historical permissive shape.

**Migration**

If you hand-construct `memory.extract` payloads (custom agents, scripts, third-party packs not authored against `@psraghuveer/memento`):

```diff
- { "kind": "decision", "rationale": "FTS5 + single file", "content": "..." }
+ { "kind": { "type": "decision", "rationale": "FTS5 + single file" }, "content": "..." }

- { "kind": "snippet", "language": "shell", "content": "memento init" }
+ { "kind": { "type": "snippet", "language": "shell" }, "content": "memento init" }

- { "kind": "fact", "content": "..." }
+ { "kind": { "type": "fact" }, "content": "..." }
```

Everything else is additive — interactive `init` falls back to print-only behaviour on a non-TTY or with `--no-prompt`, and the MCP `instructions` field is silently ignored by any (non-spec-compliant) client that doesn't honour it. No data-migration required.
