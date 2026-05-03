# @psraghuveer/memento-core

## 0.6.0

### Minor Changes

- a83c2c0: End-to-end security hardening pass before public launch. Findings from a full-codebase audit (DoS surface, scrubber correctness, import/export trust boundaries, dashboard auth, storage hygiene, install supply-chain) addressed in code, with regression tests and updated docs. Defaults are conservative — every behaviour change is either rejecting input that was already a DoS or bypass risk, or a new opt-in. Functional behaviour on the happy path is unchanged.

  **Scrubber correctness** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

  - Now scrubs `summary` and (for `decision`-kind memories) `kind.rationale` in addition to `content`. Earlier the scrubber operated on `content` only — an LLM auto-generating a summary from raw content trivially round-tripped secrets into the persisted summary, defeating the whole defence.
  - Two new default rules: `private-key-block` (PEM private-key blocks) and `bearer-token` (HTTP `Authorization: Bearer …`). Previously claimed in `SECURITY.md` but missing from the code.
  - Email regex rewritten to be ReDoS-safe (split the domain into non-overlapping label classes); JWT regex tightened to admit real-world short payloads.
  - New `scrubber.engineBudgetMs` ConfigKey (default 50 ms) caps each rule's wallclock runtime; aborts a runaway operator-installed regex without blocking the writer thread.
  - `scrubber.enabled` and `scrubber.rules` flipped to immutable at runtime (`mutable: false`). A prompt-injected MCP `config.set` can no longer disable redaction before writing a secret. `IMMUTABLE` error fires regardless of which surface invoked the command.

  **Import re-stamp policy** (`@psraghuveer/memento-core`, ADR-0019)

  `memento import` no longer trusts caller-supplied audit claims. Three transformations always happen on every imported artefact, regardless of flags:

  1. `OwnerRef` rewritten to local-self (closes the future-multi-user owner-spoofing vector at the wire boundary; AGENTS.md rule 4).
  2. Memory `content` / `summary` / `decision.rationale` re-scrubbed using the **importer's** current rule set. An artefact authored on a host with a weaker scrubber has its secrets re-redacted on arrival.
  3. `MemoryEvent.payload`, `Conflict.evidence`, and `ConflictEvent.payload` JSON capped per record at 64 KiB. A forged artefact cannot stuff multi-megabyte audit-log blobs.

  On top of those, the new `--trust-source` flag controls the audit chain. Default (flag absent): the source artefact's per-memory event chain is collapsed into one synthetic `memory.imported` event per memory; `actor` and `at` reflect the importer, not the source. With `--trust-source`: original events are inserted verbatim — for the "I am restoring my own backup, preserve the history" case. The `imported` variant is added to `MEMORY_EVENT_TYPES` and migration `0006_memory_events_imported_type.ts` widens the SQLite CHECK constraint to admit it.

  **Resource caps** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`, `@psraghuveer/memento-server`, `@psraghuveer/memento-embedder-local`)

  A wire input that previously could OOM the process is now rejected with `INVALID_INPUT`. Every cap has a structural ceiling at the schema boundary plus an operator-tunable floor below it.

  - `memory.write`/`write_many`/`supersede`/`extract` content > 1 MiB rejected at the schema; `safety.memoryContentMaxBytes` (default 64 KiB) tightens at the handler. Companion caps: `safety.summaryMaxBytes` (2 KiB), `safety.tagMaxCount` (64).
  - New stdio transport wrapper enforces `server.maxMessageBytes` (default 4 MiB, immutable). A peer that withholds the trailing newline can no longer grow the JSON-RPC read buffer until Node OOMs.
  - Local embedder accepts `embedder.local.maxInputBytes` (default 32 KiB, immutable; UTF-8-safe truncation before tokenisation) and `embedder.local.timeoutMs` (default 10 s, immutable; `Promise.race` against the embed call).
  - `memento import` rejects artefacts larger than `import.maxBytes` (default 256 MiB) up-front via `fs.stat`, then streams the file via `readline.createInterface`. Multi-GB artefacts no longer OOM the CLI before parsing begins.

  **Dashboard hardening** (`@psraghuveer/memento-dashboard`, `@psraghuveer/memento-core`)

  The dashboard is the project's only network-bound surface. Three independent defence layers added:

  1. **Per-launch random token.** Every `memento dashboard` invocation mints a 256-bit token and embeds it in the URL fragment passed to the browser. The SPA reads it from `window.location.hash`, persists to `sessionStorage`, sends `Authorization: Bearer …` on every API call. Closes the "any local process can hit `127.0.0.1:<port>`" gap. Note: bookmarks of the dashboard URL no longer work — re-launch via `memento dashboard` to get a fresh token.
  2. **Origin guard now exact-port-matched** (was: prefix-match against any localhost). A sibling localhost web server (Vite dev server, another local app) can no longer forge requests against the dashboard.
  3. **Host-header allowlist** for DNS-rebinding defence: only `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` accepted.

  Plus: a new `'dashboard'` value on `CommandSurface`. Only commands the UI uses today are opted in (read paths + `memory.confirm`/`update`/`forget`, `config.*`, `conflict.list`/`resolve`); everything else (writes, supersede, set_embedding, archive variants, restore, _\_many, conflict.scan, embedding.rebuild, compact.run, memory.context, memory.extract, system.list_tags) returns `INVALID_INPUT` from the dashboard pointing at the CLI. Hono `secureHeaders` (CSP, X-Frame-Options DENY, nosniff, no-referrer); 4 MiB body limit on `/api/commands/_`; static handler now does realpath-based containment; sourcemaps no longer ship in production builds.

  **Storage and file hygiene** (`@psraghuveer/memento-core`, `@psraghuveer/memento`)

  - `pragma trusted_schema = OFF` in the canonical PRAGMA set. A user opening an attacker-supplied `.db` via `--db /tmp/evil.db` can no longer be hit by trigger-borne side effects.
  - DB files written with mode `0600`, data directory and embedder cache with mode `0700`. Memory content is operator-private even after scrubbing; permissive umasks no longer expose it on multi-user hosts.
  - `memento backup` now writes via tempfile + atomic rename (closes the existsSync→unlink→VACUUM TOCTOU), uses `VACUUM INTO ?` with a bound parameter (was: single-quote-escape interpolation), and produces a 0600 file.
  - `INTERNAL` and `STORAGE_ERROR` messages returned to MCP clients have absolute filesystem paths replaced with `<path>` (was: SQLite errors leaked `/Users/<name>/...` to the wire). Well-known messages (NOT_FOUND, CONFLICT) are preserved for actionable error UX.
  - `memento init`'s WAL/SHM/journal-sidecar cleanup now `lstat`s before unlink and refuses anything that isn't a regular file (closes the symlink-replacement footgun on shared `/tmp` paths).
  - `memento export` defaults to `flags: 'wx'` (refuse to clobber existing files), `mode: 0o600`. New `--overwrite` flag opts in.

  **Install / supply-chain hardening** (`@psraghuveer/memento`)

  - Both postinstall scripts now pass a closed env allowlist when invoking `npm`/`npx`. Drops `npm_config_script_shell`, `NODE_OPTIONS`, `PREBUILD_INSTALL_HOST`, every other `npm_config_*` env, etc. — closes the documented "malicious sibling dep stages env vars to subvert npm" supply-chain vector.
  - `npm`/`npx` resolved via `process.env.npm_execpath` (set by npm during install) instead of `PATH`. Avoids `node_modules/.bin/npm` hijack by a colluding dep with a `bin: "npm"` entry.
  - Embedder model cache moved from `node_modules/.../@huggingface/transformers/.cache/` to `$XDG_CACHE_HOME/memento/models` (or platform equivalent). Persistent across reinstalls, owner-private, and not plantable from `node_modules`. **First run after upgrade re-downloads the model (`bge-base-en-v1.5`, ~110 MB) into the new location.**
  - `memento doctor --mcp` JSON-parse failures report only the error class name, dropping byte-positional context (Node 22's SyntaxError can include surrounding-line bytes; some MCP client configs hold API tokens; doctor reports get pasted into bug reports).

  **Documentation**

  - New ADR: [ADR-0019 — Import re-stamp policy](docs/adr/0019-import-re-stamp-policy.md).
  - `SECURITY.md` rewritten — "Defenses Memento Provides" / "Does Not Provide" sections now match what the code delivers.
  - `KNOWN_LIMITATIONS.md` extended (dashboard token is per-launch; embedder cache moved to XDG).
  - `docs/architecture/{config,scrubber,data-model}.md` updated for new ConfigKeys, scrubber rules + summary/rationale coverage, the `imported` event variant.
  - `AGENTS.md` rules 4 and 11 cross-reference ADR-0019.
  - ADR-0012 marked as extended; the `safety.*` namespace now also carries the resource caps added in this pass.

  **Behaviour changes worth knowing**

  - Writes that were previously accepted but DoS-shaped (e.g. > 64 KiB content, > 4 MiB JSON-RPC message, multi-GB import) are now `INVALID_INPUT`. No legitimate workflow is affected; raise `safety.*` / `import.maxBytes` if your data exceeds the defaults.
  - `config.set scrubber.enabled` / `scrubber.rules` from MCP now returns `IMMUTABLE`. Set them at startup via configuration overrides instead.
  - `memento export` refuses to overwrite by default; pass `--overwrite` to keep the prior behaviour.
  - `memento dashboard` URLs include a token fragment; bookmarks of the URL won't authenticate on a future visit (re-launch to get a fresh URL).
  - First `memento dashboard` / vector-search after upgrade re-downloads the embedder model into the new XDG cache location.

### Patch Changes

- Updated dependencies [a83c2c0]
  - @psraghuveer/memento-schema@0.5.0

## 0.5.2

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

- Updated dependencies [d70b151]
  - @psraghuveer/memento-schema@0.4.1

## 0.5.1

### Patch Changes

- fe72460: Persona-driven UX, install, and brand polish across the CLI, core, dashboard, and embedder.

  **CLI** (`@psraghuveer/memento`)

  - **Node 22.11+ baseline.** Node 20 exited LTS on 2026-04-30; the runtime check in `init` and `doctor` now correctly enforces this. Previously a user on Node 20 would pass the version check but crash later when `better-sqlite3` tried to load against the wrong ABI. CI matrix now tests Node 22 and 24.
  - **`doctor` no longer reports false positives** for `native-binding` and `embedder` checks when run from a bundled CLI inside a workspace (e.g. `node packages/cli/dist/cli.js doctor` against the local build). The probes fall back to a filesystem walk when `require` resolution fails for resolution reasons (not actual binding/load failures), so the doctor's verdict reflects reality instead of a require-graph quirk.
  - **Global flags accepted in any position.** `memento --format text init` and `memento init --format text` now both parse — previously the second form errored "unknown argument '--format' for 'init'". Same for `--db`, `--debug`. `--` separator semantics preserved (POSIX behavior pre-subcommand, pass-through after).
  - **`doctor` text renderer.** A flat ✓/✗ checklist with hint lines on failure and a one-line summary, instead of pretty-printed JSON. JSON path unchanged for pipes / `--format json`.
  - **`init` next-steps footer.** After printing the MCP snippets, `init` now points at `memento status` (one-screen summary) and `memento dashboard` (browser UI). Closes the journey loop instead of dropping the user mid-air.
  - **Help regrouped by purpose** — Setup / Verify & inspect / Operate / Help & teardown — instead of an alphabetical-ish wall.
  - **Banner color now matches the brand accent** (truecolor amber `rgb(232 184 108)`) instead of cyan. Aligns with the dashboard's `--accent` token and the new landing page.
  - **Dashboard launcher always prints the readiness URL** on stderr. Previously gated on `isStderrTTY`, which silently hid the URL from anyone running `memento dashboard --no-open` or with stderr redirected. The browser auto-open is best-effort; the printed URL is now the deterministic surface.
  - **Workspace install self-heal.** A new root `postinstall` (`scripts/ensure-better-sqlite3.mjs`) plus a workspace-detector in the CLI's end-user `postinstall` together prevent the "Could not locate the bindings file" trap that bit every fresh contributor. Source tracked in [`packages/cli/scripts/postinstall.mjs`](https://github.com/veerps57/memento/tree/main/packages/cli/scripts/postinstall.mjs).

  **Core** (`@psraghuveer/memento-core`)

  - **`memory.update` patch validation now hands out actionable redirects** instead of `Unrecognized key(s) in object`. Trying to `update({ patch: { content: ... } })` returns "cannot update `content` via memory.update — use memory.supersede"; same for `scope` (→ supersede) and `storedConfidence` (→ confirm or supersede). Delivers on the promise in AGENTS.md rule 13. Visible to AI assistants over MCP and to humans via `memento memory update`.

  **Embedder** (`@psraghuveer/memento-embedder-local`)

  - **Silenced the noisy `dtype not specified for "model"` warning** that transformers.js emitted on the first `embed()` call by pinning `dtype: 'fp32'` (the bge-\* family's training precision and the lib's own default). Behavior is identical; output is just quieter.

  **Dashboard** (`@psraghuveer/memento-dashboard`)

  - **Command palette feels smoother.** Debounce bumped 120ms → 250ms (the search-as-you-type sweet spot) and TanStack Query's `placeholderData: keepPreviousData` keeps prior results visible during refetch — no more "no matches" flash between keystrokes.
  - **Browser tab title** is now `memento — dashboard` (so users with both the marketing landing and the dashboard open can tell tabs apart) and the dashboard inherits the marketing landing's amber-`m` favicon for visual continuity.

## 0.5.0

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

### Patch Changes

- Updated dependencies [d1b6aaf]
  - @psraghuveer/memento-schema@0.4.0

## 0.4.0

### Minor Changes

- 544e96b: Add memory.context and memory.extract commands (ADR-0016)

  - `memory.extract`: batch extraction with embedding-based dedup (skip/supersede/write) and configurable confidence defaults
  - `memory.context`: query-less ranked retrieval for session-start context injection
  - ~13 new config keys for extraction thresholds, context limits, and ranking weights
  - Remove dead code (`commands/memory/errors.ts`)
  - Harden test coverage across bulk commands, retrieval pipeline, CLI lifecycle, and doc renderers

### Patch Changes

- Updated dependencies [544e96b]
  - @psraghuveer/memento-schema@0.3.0

## 0.3.0

### Minor Changes

- 1fdbf05: Embeddings default-on: flip `retrieval.vector.enabled` to `true`, add `embedding.autoEmbed` config key for fire-and-forget embedding on write, upgrade default model to `bge-base-en-v1.5` (768d), move `@psraghuveer/memento-embedder-local` to a regular dependency, and make the search pipeline degrade gracefully to FTS-only on transient embed failures.

### Patch Changes

- Updated dependencies [1fdbf05]
  - @psraghuveer/memento-schema@0.2.0

## 0.2.0

### Minor Changes

- b64dd5d: Improve MCP usability for AI assistants

  - Flatten `conflict.scan` input schema from discriminated union to flat object with refinements, fixing empty-schema rendering in MCP clients (e.g. Claude Desktop)
  - Add `tags` filter to `memory.list` and `memory.search` (AND logic, normalised to lowercase)
  - Add migration 0005: rebuild FTS5 index with `tags` column so tags are text-searchable
  - Add `memory.confirm_many` command for batch re-affirmation of multiple memories
  - Add `includeEmbedding` option to `memory.list` and `memory.search` (defaults to false, stripping large vectors from output)
  - Add `system.list_tags` command for discovering tags in use, sorted by frequency

## 0.1.1

### Patch Changes

- 3957548: Improve MCP tool usability for AI agents

  - Add `.describe()` annotations to all Zod input schemas with examples and format hints
  - Inject OpenAPI 3.1 discriminator hints into JSON Schema output for discriminated unions
  - Include Zod issue summary in INVALID_INPUT error messages for self-correction
  - Default `owner` to `{"type":"local","id":"self"}`, `summary` to `null`, `pinned` and `storedConfidence` to config-driven values (`write.defaultPinned`, `write.defaultConfidence`)
  - Add usage examples to command descriptions
  - Enhance tool discoverability: scope hints, confirm gate guidance, workflow notes

- Updated dependencies [3957548]
  - @psraghuveer/memento-schema@0.1.1
