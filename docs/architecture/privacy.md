# Architecture: Privacy & the `sensitive` flag

This document describes how the `sensitive` flag on a memory interacts with every internal pipeline that touches it. It is the answer to the question *"if I mark a memory `sensitive: true`, what does the system actually do — beyond redacting it in projections?"*.

The `sensitive` flag is distinct from the [scrubber](scrubber.md):

- The **scrubber** is a write-time content transformation. It rewrites the persisted bytes to remove things that look like secrets. There is no way to recover the original.
- The **`sensitive` flag** is a per-memory metadata bit. The bytes are stored verbatim. The flag controls how those bytes are *projected* by read paths.

A memory can be both, neither, or either. In particular, sensitive does not mean secret — secrets are scrubbed. Sensitive means *"the operator has asked us not to splash the content into responses by default."*

## The contract

A row with `sensitive = 1` behaves identically to any other row for every storage and ranking purpose. The only differences are at projection time, governed by the `privacy.redactSensitiveSnippets` config (default `true`):

| Read path        | When redacted? | Behaviour |
|------------------|----------------|-----------|
| `memory.read`    | never          | Always returns full `content`. Reading by id is an explicit, scoped request (ADR-0012 §3). |
| `memory.list`    | when redact=on | Projects sensitive rows to `{ content: null, redacted: true }`. All metadata (`id`, `scope`, `kind`, `pinned`, `createdAt`, `updatedAt`, `lastConfirmedAt`, `tags`, `confidence`, `effectiveConfidence`) remains visible. |
| `memory.search`  | when redact=on | Same projection as `list`. Score and `breakdown` remain visible so the assistant can still decide whether to surface the row to the user (e.g. by id reference). |

The flag does **not** filter rows out of result sets. A sensitive memory that scores highly is still ranked highly — the assistant just sees a redacted snippet and must request the content explicitly via `memory.read` (an action the host can gate on user consent).

## What the flag does *not* change

These paths treat `sensitive = 1` exactly the same as `sensitive = 0`. This is intentional and is the substantive clarification this document exists to provide.

### Embeddings

`memory.set_embedding`, `embedding.rebuild`, and `reembedAll` (`packages/core/src/embedding/reembed.ts`) all operate on the active corpus without inspecting the `sensitive` flag. A sensitive memory:

- **Is embedded.** Its `content` is fed to the embedding provider on first write (when the host wires one) and on bulk re-embed.
- **Stores its vector verbatim.** No bit-flipping, masking, or noise injection is applied to the stored vector.
- **Participates in vector candidate selection** when `retrieval.vector.enabled` is on, on equal terms with non-sensitive rows.

The redaction layer runs *after* ranking, on the projected result set. The vector itself is never returned to a caller; it exists only as an internal candidate-generation key. Treating sensitive content uniformly at the embedding layer keeps recall honest: the assistant can still find the row when the user later asks for it by id.

If your threat model requires that sensitive content never reach the embedding provider at all (for example: the provider is a third-party HTTP API), the supported mitigation is to **not wire that provider** — `@psraghuveer/memento-core` runs without an embedder, and `embedding.rebuild` is simply absent from the registry (`packages/core/src/bootstrap.ts`). Per-row provider selection is not a v1 capability and is intentionally out of scope.

### Full-text search index

The FTS5 index is populated from `content` on write. Sensitive rows are indexed identically to non-sensitive rows. An FTS query that lexically matches a sensitive row will return that row in the candidate set; redaction happens at projection.

### Audit events

`MemoryEvent` rows record state transitions for sensitive memories with the same shape as for non-sensitive memories. Event metadata may include the field-level `sensitive` value itself (so you can audit who flipped the flag and when), but event rows do not duplicate `content`. The audit trail is content-free by construction — a structural property of the `MemoryEventPayload` shape, not a configuration.

### Conflict detection

`conflict.scan` and the post-write hook treat sensitive rows as candidates on equal terms with the rest of the corpus. The returned `Conflict` rows reference sensitive memories by id; if a caller then projects the referenced memory, the redaction layer applies as it would for any other read.

## Summary

The `sensitive` flag is a **projection** control, not a **storage** control. It hides snippets in `list` and `search` output unless the operator turns redaction off; it does not remove the memory from any internal index, prevent embedding, or change ranking. The single operator-visible knob is `privacy.redactSensitiveSnippets` — binary on purpose.

Tests asserting this contract live in [`packages/core/test/privacy/sensitive-embedding.test.ts`](../../packages/core/test/privacy/sensitive-embedding.test.ts).
