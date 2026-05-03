# @psraghuveer/memento-schema

## 0.4.1

### Patch Changes

- d70b151: Lean responses + clear signals so AI assistants — and human operators — can use Memento intuitively.

  Themed pass driven by a persona-3 production test (an AI assistant calling Memento over MCP). Every response was audited for "did the assistant know what just happened, what to expect next, and what to do?" — the gaps below were the failures.

  **Embedding vectors stripped from single-memory responses** (`@psraghuveer/memento-core`)

  - `memory.write`, `memory.update`, `memory.confirm`, `memory.forget`, `memory.archive`, `memory.restore`, `memory.supersede`, `memory.set_embedding` no longer echo the 768-float embedding vector back. Previously a single `memory.read` could push ~12KB of pure noise into the assistant's context window for free.
  - `memory.read` now accepts an opt-in `includeEmbedding: true` for the rare debugging case (the only single-memory command where echoing the vector has a real use case).
  - `memory.list` and `memory.search` already stripped by default; behavior unchanged.

  **New `embeddingStatus` field on every memory output** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

  The previous `embedding: null` was ambiguous — an assistant couldn't tell "vector retrieval is off," "embedder hasn't caught up yet," and "stripped from this response" apart. Three states, one response, no infrastructure work for the assistant. Surfaced on every memory output:

  - `'present'` — the vector exists (whether echoed back or stripped)
  - `'pending'` — `retrieval.vector.enabled` is true but the embedder hasn't run yet (common right after a write)
  - `'disabled'` — vector retrieval is off

  Additive (optional field on `MemoryBaseSchema`); existing storage layers and consumers stay unchanged.

  **`get_memory_context` returns a `hint` when results are empty** (`@psraghuveer/memento-core`)

  A fresh assistant calling `get_memory_context` on an empty store would otherwise see `{ results: [], resolvedKinds: [...] }` and have no nudge to start writing. The new `hint` field distinguishes "store is genuinely empty — capture preferences as they come up" from "no matches in the requested scope — try a different filter." Set only when `results.length === 0`; absent otherwise.

  **`extract_memory` response now carries `mode` and `hint`** (`@psraghuveer/memento-core`)

  In the default async mode (per `extraction.processing` config), `memory.extract` returned `{ written: [], skipped: [], superseded: [], batchId, status: 'accepted' }` — empty arrays gave assistants no way to tell users what happened. The response now also includes:

  - `mode: 'sync' | 'async'` — `'sync'` means the arrays are authoritative; `'async'` means processing in background, expect ~1–5 sec, do not retry
  - `hint` (async only) — explicit next-step guidance: "Processing N candidate(s) in background. Results land as memories within ~1–5 seconds; verify with list_memories or search_memory if needed."

  Both fields are additive; sync responses gain `mode: 'sync'`, async responses gain `mode: 'async'` + `hint`.

  **`update_memory` redirect short-circuits redundant errors** (`@psraghuveer/memento-core`)

  Previously, `update_memory({ patch: { content: '...' } })` returned both the helpful `cannot update content — use memory.supersede` redirect (good) AND a redundant `patch must change at least one field` (noise — `content` was the field, the redirect already explained why it was rejected). The `superRefine` now short-circuits the second check when forbidden-key issues already fired, so the response stays a single actionable line.

  **New `user.preferredName` config + `system.info` surface** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

  The bundled assistant skill teaches AIs to attribute writes ("Raghu prefers pnpm" rather than "User prefers pnpm"), but there was no canonical way to discover the user's preferred handle. New `user.preferredName` config key (string, nullable, default `null`); the value is surfaced in `system.info.user.preferredName` so the assistant learns it once at session start. When `null`, the skill instructs the assistant to write "The user" instead. Set with `memento config set user.preferredName "<name>"`.

  **Dashboard personalization + brand-title alignment** (`@psraghuveer/memento-dashboard`)

  - The dashboard wordmark in the top bar now reads `<name>@memento_` when `user.preferredName` is set — a shell-prompt cue that matches the dashboard's terminal aesthetic (`~/overview`, `~/memory/$id` route style). Falls back to `memento_` when null. Reuses the existing blinking-cursor caret; no new visual concept.
  - Browser tab title aligned to `Memento — Dashboard` (was `memento — dashboard`) for visual parity with the landing page (which now reads `Memento — A local-first, LLM-agnostic memory layer for AI assistants` everywhere — `<title>`, OG title, Twitter title).

  **Skill + tool description alignment** (`skills/memento/SKILL.md`, tool descriptions for `write_memory`, `update_memory`, `read_memory`, `extract_memory`, `info_system`, `write_many_memories`)

  The conflict-detection policies for `preference` and `decision` parse the first line of `content` as `key: value` — but the skill's worked example used freeform prose, so AIs following the skill silently bypassed conflict detection. Skill and the `write_memory` tool description now teach a two-line pattern: `topic: value` on line 1 (the structural anchor for the detector) followed by free prose for retrieval. Without that line, two contradictory preferences ("I use bun" vs "I use npm") will silently coexist instead of being surfaced for triage.

  The skill also now contains a **Quick decision tree** appendix covering the four most-touched judgement calls in any session — which write tool (`write_memory` vs `extract_memory` vs N-sequential-writes vs `write_many_memories`), which kind (with the rule-of-thumb "does the user expect to defend the choice if asked 'why'?" → `decision`; otherwise `preference`), which scope (user-facts → `global`, project-facts → `repo`), and when to deviate from the `storedConfidence` / `pinned` / `sensitive` defaults.

  `write_many_memories` tool description rewritten to make clear it is a programmatic / operator surface — for batched explicit user statements, AI assistants should prefer N sequential `write_memory` calls (no all-or-nothing rollback) or `extract_memory` (server dedups + scrubs). `clientToken` description marked as a programmatic-idempotency surface (scripts, migrations, retry-safe pipelines) that AI assistants typically omit. `update_memory` field list corrected from `(tags / kind / pinned)` to `(tags / kind / pinned / sensitive)` everywhere it appeared. `forget` vs `archive` distinction tightened to a single rule: **forget retracts (was wrong); archive retires (was right, no longer current)**.

  The skill additionally documents:

  - The async-extract response contract (`mode` + `hint` — empty arrays are not failure)
  - The `info_system.user.preferredName` flow for user attribution

  `docs/architecture/conflict-detection.md` adds a paragraph noting that the per-policy first-line shape is the contract the skill teaches — so future contributors don't try to "fix" the silent-conflict case by widening the detector and end up with false positives instead. `docs/architecture/data-model.md` documents the new `embeddingStatus` field as a wire-only projection. `docs/architecture/decay-and-supersession.md` and `docs/guides/teach-your-assistant.md` updated to match the corrected `update_memory` field list and to teach the same `key: value` shape + `info_system.user.preferredName` attribution pattern as the skill (so non-skill clients — Cursor, Cline, OpenCode — get the same guidance via the persona snippet).

  **Skill install discoverability** (no package bumps; `skills/README.md`, `CONTRIBUTING.md`, `AGENTS.md`)

  The contributor `memento-dev` skill was essentially undiscoverable — no mention in `CONTRIBUTING.md` or `AGENTS.md`, and `skills/README.md`'s install section was written entirely for the end-user `memento` skill. Now:

  - `skills/README.md`: install section split into "End users: the `memento` skill" (existing path via `memento init`) and "Contributors: the `memento-dev` skill" (one-line `cp -R` install + a "verifying the dev skill auto-triggers" walkthrough)
  - `CONTRIBUTING.md`: new "Install the contributor skill (Claude Code only)" subsection in Local setup
  - `AGENTS.md`: dev-skill install promoted to the top of the "For AI agents specifically" section, framing it as the load-on-intent companion to AGENTS.md itself

  The `memento-dev` skill also picked up two new pitfalls — workspace postinstall coordination (`scripts/ensure-better-sqlite3.mjs` ↔ `packages/cli/scripts/postinstall.mjs`) and the `topic: value` first-line requirement for new `preference` / `decision` features — and corrected the `memory.update` field list to include `sensitive`.

## 0.4.0

### Minor Changes

- d1b6aaf: perf: async extraction, batched embeddings, and bulk repository operations (ADR-0017)

  ### `@psraghuveer/memento-schema`

  - New config key `extraction.processing` (`'sync' | 'async'`, default `'async'`) controls whether `memory.extract` blocks until completion or returns a receipt immediately.
  - New config keys `embedding.rebuild.defaultBatchSize` and `embedding.rebuild.maxBatchSize` for tuning bulk re-embedding.

  ### `@psraghuveer/memento-core`

  - **Batched embeddings:** `EmbeddingProvider` gains an optional `embedBatch(texts)` method. `embedBatchFallback` helper delegates to it when present, falling back to sequential `embed()` calls. `reembedAll` uses batch-first with graceful per-row fallback on batch failure.
  - **Async extract processing:** `memory.extract` in `async` mode (now the default) returns a `{ batchId, status: 'accepted' }` receipt immediately and processes candidates in the background. Sync mode pre-computes all embeddings via `embedBatch` upfront instead of per-candidate.
  - **Bulk repository methods:** `forgetBatch`, `archiveBatch`, and `confirmBatch` wrap all transitions in a single SQLite transaction. `archive_many` parallelises its 3 `listIdsForBulk` queries via `Promise.all`.

  ### `@psraghuveer/memento-embedder-local`

  - Implements `embedBatch` on the local ONNX embedder (sequential under the hood until transformers.js adds batch inference).

## 0.3.0

### Minor Changes

- 544e96b: Add memory.context and memory.extract commands (ADR-0016)

  - `memory.extract`: batch extraction with embedding-based dedup (skip/supersede/write) and configurable confidence defaults
  - `memory.context`: query-less ranked retrieval for session-start context injection
  - ~13 new config keys for extraction thresholds, context limits, and ranking weights
  - Remove dead code (`commands/memory/errors.ts`)
  - Harden test coverage across bulk commands, retrieval pipeline, CLI lifecycle, and doc renderers

## 0.2.0

### Minor Changes

- 1fdbf05: Embeddings default-on: flip `retrieval.vector.enabled` to `true`, add `embedding.autoEmbed` config key for fire-and-forget embedding on write, upgrade default model to `bge-base-en-v1.5` (768d), move `@psraghuveer/memento-embedder-local` to a regular dependency, and make the search pipeline degrade gracefully to FTS-only on transient embed failures.

## 0.1.1

### Patch Changes

- 3957548: Improve MCP tool usability for AI agents

  - Add `.describe()` annotations to all Zod input schemas with examples and format hints
  - Inject OpenAPI 3.1 discriminator hints into JSON Schema output for discriminated unions
  - Include Zod issue summary in INVALID_INPUT error messages for self-correction
  - Default `owner` to `{"type":"local","id":"self"}`, `summary` to `null`, `pinned` and `storedConfidence` to config-driven values (`write.defaultPinned`, `write.defaultConfidence`)
  - Add usage examples to command descriptions
  - Enhance tool discoverability: scope hints, confirm gate guidance, workflow notes
