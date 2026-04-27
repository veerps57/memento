# ADR-0012: Safety gates — confirm, idempotency, redaction, batch limits

- **Status:** Accepted
- **Date:** 2025-01-29
- **Deciders:** core
- **Tags:** mcp, registry, safety, privacy

## Context

The user-story audit surfaced four overlapping gaps that all
share the same property: an LLM-driven assistant can issue
correct-looking calls with damaging or surprising effects, and
the registry has no mechanism today to slow them down.

1. **G2 — destructive calls have no confirm gate.** An assistant
   can call `memory.forget`, `memory.archive`, `compact.run`, or
   `embedding.rebuild` from a single auto-generated tool call.
   The latter three rewrite or delete real data. Nothing in the
   schema distinguishes a deliberate destruction from a model
   hallucination.

2. **G3 — `memory.write` has no idempotency primitive.** A
   client that retries a write (network blip, MCP reconnect,
   model self-loop) creates duplicate memories. Today the only
   defence is post-hoc conflict detection, which fires *after*
   the duplicate is in the store.

3. **G4 — sensitive content has no representation.** Some
   memories are sensitive (passwords, customer-identifying
   notes, private keys). The store has no way to mark them, and
   `memory.search` / `memory.list` always return the full
   `text`. An assistant that surfaces results will leak them
   into chat logs.

4. **G5 — no bulk write path.** Importing notes from another
   tool means N round trips, each its own transaction, each its
   own audit row, with no atomicity. Power users hit this fast.

These four are best decided together: the confirm gate
establishes the *shape* of an out-of-band caller acknowledgement
(a literal field in the input schema), and `clientToken`,
`sensitive`, and `write_many` reuse the same shape for their
respective acknowledgements / metadata.

The four guiding principles plus the 14 non-negotiable rules
constrain the design:

- **Rule 12 (invariants are not configurable).** A confirm gate
  on destructive operations is an invariant — there is no
  deployment mode where forgetting a memory should be silent.
- **Rule 2 (no hardcoded behavioural constants).** Conversely,
  the *amount* of redaction or the batch ceiling are policy
  knobs and must be `ConfigKey`s.
- **Rule 3 (audit on writes).** Idempotent retries must not
  emit duplicate audit rows; sensitive marks and confirm flags
  must be visible in the audit trail.
- **Rule 5 (immutable id/createdAt/scope).** Idempotency keys
  must respect scope as a partition.

## Decision

We add four safety gates to the registry, governed by one new
ADR (this one) and four new sub-phases in Phase 3. Each is
detailed below.

### 1. Confirm gate (Rule 12 invariant — not config-driven)

Four input schemas gain a required `confirm: z.literal(true)`
field:

- `MemoryForgetInputSchema`
- `MemoryArchiveInputSchema`
- `CompactRunInputSchema`
- `EmbeddingRebuildInputSchema`

Validation messages are uniform and explicit:

> `this operation is destructive; pass { confirm: true } to proceed`

`memory.supersede` does **not** get the gate. Superseding is
constructive (it inserts a new memory and links the old one);
the link itself is recoverable and the old memory remains
visible by id.

Why a literal field rather than a config flag or
adapter-level prompt:

- The CLI and MCP adapters share the same registry contract;
  putting the gate at the schema layer means both surfaces
  enforce it identically without any per-adapter UX code.
- A literal in the schema is self-documenting in the generated
  MCP tool descriptors.
- Per Rule 12, the gate is invariant — making it a
  `ConfigKey` would invite a deployment that disables it.

### 2. `clientToken` idempotency (per-scope)

`memory.write` accepts an optional
`clientToken: z.string().min(1).max(128).optional()`. Semantics:

- If the request supplies `clientToken`, the repository looks
  up `(scope, clientToken, status='active')` *before* the
  insert.
- A hit returns the existing memory id, no new audit row, no
  insert. The output schema is identical.
- A miss inserts the memory with `client_token` populated.

A new migration adds `memories.client_token TEXT NULL` and a
unique partial index:

```sql
CREATE UNIQUE INDEX memories_active_client_token
  ON memories (scope_serialized, client_token)
  WHERE status = 'active' AND client_token IS NOT NULL;
```

The partial filter on `status='active'` is deliberate:
forgetting a memory clears its status, freeing the same client
token for reuse in the same scope. Across scopes, the same
token is always allowed (different `scope_serialized`).

`clientToken` does **not** apply to `memory.update` or
`memory.supersede`. Updates are explicitly targeted by id;
supersede has its own causality.

### 3. `sensitive` flag + `privacy.redactSensitiveSnippets`

`MemoryWriteInputSchema` and `MemoryUpdateInputSchema` accept
`sensitive: z.boolean().optional()` (defaults to `false`).

A new migration adds `memories.sensitive INTEGER NOT NULL DEFAULT 0`.

A new `ConfigKey` `privacy.redactSensitiveSnippets` defaults to
`true`. When set:

- `memory.search` and `memory.list` outputs project the
  `text` field to `null` and add `redacted: true` for sensitive
  rows. The `id`, `scope`, `createdAt`, score, and any
  non-text metadata remain visible so the assistant can offer
  the user a "show full content" follow-up.
- `memory.read` *always* returns the full text regardless of
  the flag. Reading by id is an explicit, scoped request.

When the config is `false`, search and list behave as today
(full text returned for sensitive rows). This is the only
knob the operator gets; it is binary on purpose.

### 4. `memory.write_many` + `safety.batchWriteLimit`

A new command `memory.write_many` accepts
`{ items: MemoryWriteInput[] }` (length 1..N where N comes from
config) and returns
`{ ids: string[]; idempotentCount: number }`.

Semantics:

- All inserts happen in a single transaction. Any validation or
  conflict failure rolls back the whole batch.
- Each item may carry its own `clientToken`; the per-scope
  uniqueness rule still applies, including across items in the
  same batch.
- `idempotentCount` reports how many items hit an existing
  `clientToken` and were treated as no-ops.
- One audit row per actually-inserted memory; idempotent hits
  do not write audit rows (consistent with single-write
  semantics).

A new `ConfigKey` `safety.batchWriteLimit` defaults to `100`.
The schema enforces the limit at validation time so the
transaction is never opened for an over-limit request.

## Consequences

### Positive

- An LLM cannot delete or rebuild data on a single hallucinated
  tool call.
- Retries and self-loops stop creating duplicate memories.
- Sensitive content can stay in the store without leaking via
  search snippets.
- Bulk imports are atomic and one-round-trip; the cap protects
  the engine from runaway batches.

### Negative

- Every destructive command's input schema gains a literal
  field. Existing CLI users must pass `--confirm` (or equivalent)
  on those four commands.
- A new column on `memories` and a new partial index. The
  index is small and only covers active rows.
- Two new `ConfigKey`s; the registry contract grows by one
  command.

### Risks

- **Confirm-gate fatigue.** Operators might wrap the four
  commands in scripts that always pass `confirm: true`. That
  is fine — the gate exists to stop *the model*, not to nag
  humans. It is one literal field, not an interactive prompt.
- **clientToken collision across legitimate retries.** If a
  client reuses the same token after a deliberate forget +
  rewrite, the second write succeeds (the partial index only
  covers active rows). Documented in `docs/architecture/state-model.md`.
- **Redaction false-confidence.** `redactSensitiveSnippets`
  redacts only the `text` field; metadata (tags, scope, time)
  may still leak hints. Mitigation: `sensitive` is a tool, not
  a vault. The README and the audit reference both call this
  out.
- **Migration cost.** Two new columns and one new index.
  Backfill is constant-time (default values); the index builds
  once on existing data.

## Alternatives considered

### Alternative A: Configurable confirm gate

Make the gate a `ConfigKey` `safety.requireConfirm` defaulting
to `true`. Rejected because Rule 12 forbids invariants behind
config; once an operator sets it to `false`, an LLM can issue
silent destructive calls again. The whole point is to make the
gate uncircumventable from inside the protocol.

### Alternative B: Idempotency at the audit layer

Detect duplicates by hashing the input and looking up audit
rows. Rejected: audit is append-only and not indexed for this
shape; making it the idempotency oracle couples write
semantics to audit forever and slows every write with a hash
probe even for non-retry traffic. The `clientToken` opt-in is
explicit and free for callers that don't supply it.

### Alternative C: Vault-style encryption for sensitive memories

Encrypt `sensitive=true` rows at rest with a key the operator
holds. Rejected for v1: out of scope, ties Memento to a
key-management story, and the practical attacker (an LLM that
echoes search results into a chat log) is fully addressed by
redaction. Encryption stays open as a future ADR.

### Alternative D: Streaming `memory.write_many`

Accept items as an MCP stream rather than an array, so very
large imports don't fit in a single message. Rejected: MCP
streaming for tool inputs isn't standardised, and
`safety.batchWriteLimit` plus client-side chunking solves the
real ergonomic case without protocol surgery.

### Alternative E: Per-call confirm prompt at the adapter

Instead of a schema field, have the MCP server emit an
elicitation request that the assistant must echo. Rejected:
elicitation is optional in MCP, not all clients implement it,
and it puts policy in the adapter (Rule 1 violation —
behaviour belongs in the registry).

## Validation against the four principles

1. **First principles.** Each gate exists because the registry
   is callable by an unsupervised LLM. The gate is the
   smallest possible obstacle that stops a single hallucinated
   call from doing damage. Confirm = invariant. Token,
   sensitive, batch = explicit caller commitments.
2. **Modular.** Each gate lives in the schema layer of the
   command it guards. Repositories implement
   `findByClientToken` and a sensitive-aware projection;
   nothing else changes shape.
3. **Extensible.** New destructive commands reuse the same
   `confirm` literal. New sensitive-like flags can be added to
   the same row without further migrations. The
   `write_many` shape is the template for any future bulk
   command (`memory.archive_many`, etc).
4. **Config-driven.** Two new `ConfigKey`s carry the policy
   knobs (`privacy.redactSensitiveSnippets`,
   `safety.batchWriteLimit`). The confirm gate is *not*
   config-driven on purpose (Rule 12). Default values are
   chosen so the safe behaviour is the out-of-the-box one.

## References

- ADR-0003 (single command registry).
- ADR-0011 (assistant-callable system commands).
- AGENTS.md rules 1, 2, 3, 5, 12.
- User-story audit gaps **G2** (confirm gate), **G3**
  (idempotency), **G4** (sensitive), **G5** (bulk write).
