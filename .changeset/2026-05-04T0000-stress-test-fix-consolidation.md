---
"@psraghuveer/memento-core": minor
"@psraghuveer/memento-schema": minor
---

Stress-test fix consolidation pass. Closes every P0/P1/P2 finding from a multi-round adversarial audit of correctness contracts and adoption-scale behaviour, with regression tests for each fix and a re-runnable stress harness checked in. Defaults are conservative — every behaviour change is either restoring a documented contract that wasn't actually firing, tightening input that was previously a silent footgun, or adding an opt-in escape hatch. Functional behaviour on the happy path is unchanged.

**Conflict detection actually fires now** (`@psraghuveer/memento-core`)

The preference / decision policies parsed `topic: value` from a regex anchored to end-of-string, so the canonical `topic: value\n\nfree prose ...` shape that AGENTS.md recommends silently coexisted instead of opening a conflict. The parser now reads only the first line, matching the documented contract. Two textbook conflict pairs (pnpm vs yarn preferences with prose; postgres vs mysql decisions with prose) now produce open conflicts via the post-write hook as advertised.

**Scrubber correctness** (`@psraghuveer/memento-schema`)

- New default rules: `db-credential`, `stripe-key`, `google-api-key`, `sendgrid-key`, `discord-token`, `basic-auth`, `credit-card`, `ssn`. Each rule has positive and negative regression tests in `packages/core/test/scrubber/defaults.test.ts`.
- `db-credential` runs *before* `email` so connection-string credentials (`postgres://user:pass@host/db`) are redacted with a labeled placeholder `<redacted:db-credential>@host` instead of being mislabeled as `<email-redacted>` and eating the host. Internal hostnames without a TLD suffix (`mysql://user:pass@mysql-host/db`) are now caught.
- `secret-assignment` rule rewritten. The old `\b(PASSWORD|SECRET|API[_-]?KEY|TOKEN)\b` form missed compound underscore-bound names because `_` is a word character. The new pattern catches `secret_token`, `aws_session_token`, `access_token`, `auth_token`, plus camelCase variants (`apiToken`, `authToken`). The greedy `\S+` value match was replaced with a class that stops at `&`, `,`, `;`, `'`, `"`, or whitespace, so URL query-string redaction (`?secret=foo&user=42`) preserves trailing parameters. Also accepts double / single-quoted values explicitly so `apiToken="value"` is caught.

**Embedding store invariants** (`@psraghuveer/memento-core`)

`memory.set_embedding` now validates the caller's `(model, dimension)` against the configured embedder when one is wired. A mismatch returns `CONFIG_ERROR` pointing at `embedding rebuild`. Without a configured embedder (offline test fixtures), the legacy "set raw vector" affordance is preserved.

**`memory.update` cross-kind rejection** (`@psraghuveer/memento-core`)

Same-type `kind` edits (snippet language change, decision rationale change, etc.) still succeed. Cross-type kind changes (snippet → fact, decision → preference) used to silently drop kind-specific metadata and shift the memory between decay classes; they now return `INVALID_INPUT` and route through `memory.supersede` so kind-specific metadata stays in the audit chain. Tool description and AGENTS.md rule 13 updated.

**`memory.extract` in-batch dedup** (`@psraghuveer/memento-core`)

Byte-identical candidates submitted in a single `extract_memory` call now collapse to one memory via a kind-aware fingerprint. The exact-match dedup fallback also became kind-aware so the same prose recorded as both a `fact` and a `decision` correctly produces two memories rather than one. Cross-batch embedding-similarity dedup is unchanged.

**`memory.forget_many` / `memory.archive_many` filter** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

- New optional `tags: string[]` field on the bulk filter (AND semantics). The bulk-cleanup pattern (`forget every memory tagged 'experimental'`) now works in one call.
- `reason` is now truly optional (was de-facto required even on `dryRun: true`). Defaults to `null` when omitted.

**`get_memory_context` candidate cap** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

New `context.candidateLimit` ConfigKey (default 500). The ranker now considers a bounded candidate set sized by recency, plus an unconditional pinned-supplement fetch so pinned memories always surface regardless of the cap. At 200k corpus, this turns the previously-linear context fetch (357 ms p50) into an O(log n) + O(candidateLimit) operation.

**`compact.run` drain mode** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

New input field `mode: 'drain' | 'batch'` (default `'drain'`). Drain loops `compact()` until a pass archives nothing or the new `compact.run.maxBatches` ConfigKey (default 100) is hit. Output gains a `batches: number` field. The legacy single-batch behaviour is reachable via `mode: 'batch'`. Operators on large corpora no longer have to invoke the command repeatedly to reach quiescence.

**Performance: `memory.list` index** (`@psraghuveer/memento-core`)

New migration `0007_memories_status_lca_index` adds `(status, last_confirmed_at desc)` to `memories`. Combined with the context candidate cap above, unscoped `memory.list({limit: 10})` and `get_memory_context()` are now O(log n) ordered fetches at any corpus size — the existing `(scope_type, status, last_confirmed_at desc)` index still backs scoped reads.

**Schema-validation error UX** (`@psraghuveer/memento-core`)

Every `INVALID_INPUT` now carries a field-path detail. The shared `formatZodIssues` helper was extracted to its own module and the repository-error mapper routes `ZodError` through it. The terse `<op>: input failed schema validation` fallback is gone — callers always get `Invalid input for command '<name>':\n  - field.path: detail`.

**Helpful ULID error message** (`@psraghuveer/memento-schema`)

Memory id, event id, session id, conflict id schemas all carry the same explanatory error: `must be a 26-character Crockford-base32 ULID (e.g. "01HYXZ1A2B3C4D5E6F7G8H9J0K")`. Replaces the bare `Invalid` that used to surface for malformed ids.

**`memory.search` whitespace rejection** (`@psraghuveer/memento-core`)

`memory.search({text: "   "})` used to pass `min(1)` validation and silently produce vector-only results. Now rejected with a clear "must contain at least one non-whitespace character" message. Tool description also documents that FTS5 syntax (AND / OR / NOT / NEAR / phrase / prefix) is not parsed — it has always been treated as a term bag, but the previous description didn't say so.

**Write-path Unicode hardening** (`@psraghuveer/memento-core`)

Every persisted free-text field (`content`, `summary`, `kind.rationale`) now goes through a single normaliser before scrubber rules run:

1. NFC normalisation, so `café` (NFD) and `café` (NFC) round-trip as one form on FTS lookup.
2. Strip zero-width characters (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM) so stored-vs-displayed presentation agrees.
3. Strip C0 control characters except `\t`, `\n`, `\r`.
4. Reject content containing the bidirectional override character (U+202E) with `INVALID_INPUT`. The codepoint flips visual reading order and is a known prompt-injection vector for AI agents that re-render memories as instructions.

**Implicit-confirm semantics surfaced in tool descriptions** (`@psraghuveer/memento-core`)

`clientToken` dedup hits and `memory.restore` calls have always bumped `lastConfirmedAt` (the de-facto "implicit confirm"). Tool descriptions now document that explicitly so callers don't assume idempotent retries leave the memory frozen for decay purposes.

**Stress-test runner** (`scripts/stress-test.mjs`, `docs/guides/stress-test.md`)

A re-runnable end-to-end harness ships under `scripts/`. `node scripts/stress-test.mjs --mode=quick|standard|full` exercises 32 correctness probes (every fix above has a probe), seeds a configurable corpus (5k / 50k / 200k), measures write throughput / search-list-context latency / vector hybrid wall-clock / `compact.run`, and writes a markdown report to the working directory. All probes pass against this PR. The guide explains the modes, flags, threshold defaults, and how to interpret regressions.

**Doc updates**

- `AGENTS.md` rule 13 — same-type-allowed / cross-type-rejected for `memory.update`.
- `docs/guides/conflicts.md` — replaced stale `conflict.detectionMode` terminology with the actual config keys.
- `docs/guides/embeddings.md` — new "Latency expectations" section documenting query-embedding wall-clock on CPU (~200–500 ms with `bge-base-en-v1.5`) and the `bge-small-en-v1.5` fallback for latency-sensitive paths.
- `docs/adr/0016` — extended the dedup section to cover the new in-batch scope (cosmetic ADR edit; the decision is unchanged).
- `packages/core/README.md` — documents the `memory.set_embedding` configured-embedder validation.
- `skills/memento/SKILL.md` — same `memory.update` cross-kind nuance.
- `docs/reference/{mcp-tools,cli,config-keys}.md` regenerated.
