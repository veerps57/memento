# ADR-0016: Assisted Extraction and Context Injection

- **Status:** Accepted
- **Date:** 2026-05-01
- **Deciders:** Raghu + Claude
- **Tags:** extraction, context, retrieval, adoption

## Context

Memento's value depends on two loops: the write loop (memories flow into the store) and the read loop (memories surface at session start). Both loops required explicit assistant discipline — the assistant had to decide what to remember and call multi-step workflows to write, and had to know what to search for at session start.

The result: stores stay empty or under-populated, and even when they have good content, memories don't surface unless the assistant happens to search the right terms. Both are adoption killers.

## Decision

Ship two new commands together:

1. **`memory.extract`** — a batch extraction command. The assistant dumps candidate memories in one call. The server handles dedup at two scopes: (a) **in-batch** — byte-identical candidates within the same call collapse to a single memory via a kind-aware fingerprint, so vector-search timing on auto-embed cannot lead to duplicate writes within one batch; (b) **cross-batch** — embedding similarity against existing active memories (two-tier threshold: ≥0.95 = duplicate/skip, 0.85–0.95 = supersede, <0.85 = write new). The server also scrubs and writes. Extracted memories are tagged `source:extracted` and start at confidence 0.8 (lower than manual writes at 1.0, so they decay faster and are pruned by `compact` if never confirmed).

2. **`memory.context`** — a query-less ranked retrieval command. Returns the most relevant memories without requiring a text query. Ranks by confidence, recency, scope specificity, pinned status, and confirmation frequency. Exposed additionally as an MCP resource (`memento://context`) and an MCP prompt (`session-context`) for progressive enhancement.

The assistant is the LLM — it already understands the conversation and can judge what's durable. MCP sampling was evaluated and rejected as the primary mechanism (human-in-the-loop approval dialog, redundant LLM call, sparse client support, no session-close trigger over stdio).

## Consequences

### Positive

- Write loop friction drops from multi-step to single call.
- Read loop works without a query — the "magic moment" of session-start context.
- Progressive enhancement via MCP resources/prompts for capable clients.
- Server-side dedup prevents noise accumulation from over-extraction.
- Lower confidence for extracted memories biases toward precision via natural decay.

### Negative

- 16 new config keys to document and maintain (`extraction.*` × 7 and `context.*` × 9).
- Embedding provider required for full dedup quality (falls back to exact-match without it).
- Persona snippets must be updated for existing users.

### Risks

- Assistant doesn't call `memory.extract` → mitigated by prominent persona instructions; the bar is one call with a batch dump.
- Over-extraction fills store with noise → mitigated by dedup thresholds, lower confidence, `compact` pruning, `source:extracted` tag for manual cleanup.
- Dedup too aggressive → mitigated by two-tier threshold (configurable), supersession preserves history.

## Alternatives considered

### Alternative A: MCP sampling for extraction

- Server-initiated LLM call to extract from conversation.
- Attractive: no assistant discipline needed.
- Rejected: human-in-the-loop approval dialog in Claude Desktop is hostile UX; the assistant is already the LLM; client support is sparse; stdio has no session-close trigger.

### Alternative B: Server-side LLM calls (direct API)

- Server calls an embedding/LLM API directly.
- Attractive: no dependency on client.
- Rejected: violates local-first principle. Memento makes no outbound network calls.

### Alternative C: No `memory.context`, just improve `memory.search`

- Fewer new commands.
- Rejected: search requires a query string. At session start, the assistant doesn't know what to search for. Query-less ranked retrieval is a fundamentally different operation.

### Alternative D: Skip dedup, rely on conflict detection

- Simpler extraction pipeline.
- Rejected: conflict detection catches contradictions, not duplicates. Writing the same fact ten times isn't a conflict — it's noise.

## Validation against the four principles

1. **First principles.** The assistant is already an LLM with conversation context — using it for extraction judgment is the simplest correct design. Context injection exists because search requires knowing what to search for; query-less ranked retrieval solves this from first principles.
2. **Modular.** `memory.extract` is a command on the registry with a standalone factory. `memory.context` reuses the existing ranker pattern with a no-query variant. Neither requires changes to the storage layer.
3. **Extensible.** MCP resources and prompts are additive. Future vector-based thematic matching can be added as a new weight term to the context ranker. MCP sampling can be added as a tier if clients gain auto-approval.
4. **Config-driven.** Dedup thresholds, extracted confidence, context limits, ranking weights, tag policy, and batch caps are all `ConfigKey`s.

## References

- ADR-0005: Conflict detection post-write hook (same fire-and-forget pattern)
- ADR-0006: Local embeddings only in v1 (dedup uses the same provider)
