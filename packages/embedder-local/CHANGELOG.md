# @psraghuveer/memento-embedder-local

## 0.7.0

### Minor Changes

- 96a62f0: Stop the `libc++abi: mutex lock failed: Invalid argument` crash on process exit for every command that loads the local embedder (ADR-0025 supersedes ADR-0024).

  A user upgraded to v0.7.2 (the ADR-0024 release) against an empty store and still hit the crash on Ctrl-C of `memento dashboard`. A focused bisection found the crash class is universal: every command that loads the embedder — `dashboard`, `serve`, `status`, `memory list`, `pack install`, `import` — was exiting with code 134 and a libc++ stack trace, even when the work itself succeeded. The crash is the destructor race between `better-sqlite3` and `onnxruntime-node` (loaded transitively by the local embedder via transformers.js) at process teardown.

  We exhaustively tried every disposal primitive available from JS — `pipeline.dispose()`, `intraOpNumThreads: 1`, `process.reallyExit(code)` (Node's `_exit(2)` equivalent) — and verified empirically that none of them skips the C++ destructor chain. The only primitive that does is `SIGKILL` to self.

  The fix has three layers:

  - **Embedder flag.** `@psraghuveer/memento-embedder-local`'s `ensureReady()` sets a `globalThis.__memento_embedder_loaded` flag the first time its loader resolves. The flag is on `globalThis` so the CLI doesn't have to depend on the embedder package at import time.
  - **CLI exit hatch.** `@psraghuveer/memento`'s `nodeIO().exit()` reads the flag. When the embedder was loaded in this process, it drains stdout/stderr and self-`SIGKILL`s — bypassing every C++ destructor, never reaching the libc++ trap. When the flag is unset (`--help`, `--version`, short commands that exit before warmup completes), `process.exit(code)` is called normally and the exit code is preserved.
  - **`MementoApp.shutdown()` keeps its three-phase teardown** from the (rewritten) ADR-0025: drain in-flight background work → call `provider.dispose()` (if defined) → run the synchronous `close()`. The dispose path is correct cleanup engineering even though insufficient on its own to avoid the crash; it stays so future providers (cloud HTTP-backed, GPU-backed) with non-thread native resources can release them gracefully.

  New public surface:

  - `EmbeddingProvider.dispose?(): Promise<void>` — optional, called from `shutdown()` after the drain phase.
  - `MementoApp.shutdown()` semantics broadened from "drain only" to "drain + dispose + close".
  - No new config keys. The existing `embedding.startupBackfill.shutdownGraceMs` continues to bound the drain phase.

  Behaviour change for shell consumers: commands that loaded the embedder now exit with code `137` (SIGKILL) instead of `134` (libc++ abort) or the pre-ADR-0024 intended exit code. Both pre- and post-fix values are non-zero — scripts using `$?` to gate success/failure see no regression. Scripts that strictly require exit code `0` from `memento status` etc. should switch to parsing the structured JSON envelope on stdout, which now prints reliably before the process dies.

  The architecturally correct fix — worker-thread isolation of the embedder so the main process exits cleanly while a worker terminate disposes ONNX — is deferred as a follow-up. ADR-0025 §Alternative B documents the rationale.

### Patch Changes

- Updated dependencies [96a62f0]
  - @psraghuveer/memento-core@0.15.0

## 0.6.2

### Patch Changes

- Updated dependencies [c430d82]
  - @psraghuveer/memento-core@0.14.0
  - @psraghuveer/memento-schema@0.12.1

## 0.6.1

### Patch Changes

- Updated dependencies [ab0eca1]
  - @psraghuveer/memento-core@0.13.0
  - @psraghuveer/memento-schema@0.12.0

## 0.6.0

### Minor Changes

- 0dc4716: Make Memento more usable for AI-assisted memory work — clearer write-side contract, stronger read-side recall, and faster batched embeddings.

  **Write side — distillation contract clarity.** The MCP tool description on `extract_memory` flags the candidate-shape difference from `write_memory` (flat `kind` enum, top-level `rationale`/`language`), states the `topic: value\n\nprose` requirement for `preference`/`decision` kinds, and notes the `storedConfidence: 0.8` async-default. An inline example shows four kinds with the correct field placement — including a `preference` candidate that opens with the required topic-line and a `decision` candidate with top-level `rationale`. `TagSchema` emits an actionable error message listing the allowed charset instead of a bare "Invalid". The skill, persona-snippet guide, and landing-page persona-snippet mirror carry a "Distillation craft" section that frames the task as retrieval indexing (not summarisation) and codifies six rules: preserve specific terms (proper nouns, identity qualifiers, dates, named entities); capture facts about every named participant, not only the user (a friend the user mentions, a colleague, a co-speaker — facts they share about themselves AND the user's observations about them are both worth indexing, attributed to the right named person); emit a candidate for every dated event with the date resolved against the session anchor; capture precursor actions alongside outcomes ("researched X" AND "chose Y" as separate candidates, since future questions can target either); don't squash enumerations into category labels; bias toward inclusion (the server dedups).

  **Read side — porter stemming for FTS5.** `memories_fts` is now built with `tokenize='porter unicode61'` instead of the default `unicode61`. The chain has unicode61 split + diacritic-fold first, then porter stem the resulting tokens — so "colleague", "colleagues", and "colleague's" share a stem and match each other in keyword search, and "bake" matches "baking" / "baked" / "bakes". Non-ASCII content still tokenises correctly because unicode61 runs first. The `retrieval.fts.tokenizer` config key now defaults to `porter` and is documented as honoured by the FTS index (previously declared but ignored). Migration 0008 drops and rebuilds `memories_fts` with the new tokenizer, preserving stable rowids via the `memories_fts_map` table; the runner applies it on first server start after upgrade, so no operator action is required. Recall on natural-language queries — where the speaker's wording and the future question's wording differ in plural, verb form, or possessive — improves at the FTS layer instead of depending on vector search to rescue every morphological miss.

  **Embedder perf — real batched feature-extraction.** `@psraghuveer/memento-embedder-local`'s `embedBatch` now uses transformers.js v3's array-input pipeline, which runs one forward pass for the whole batch instead of looping per text. Numerically identical to the single-call form (verified row-by-row against the same input). Measured ~1.8× speedup on a 3-input batch with `bge-base-en-v1.5` on CPU; the speedup grows with batch size because tokenisation and pipeline setup amortise across the batch. The loader contract now returns `{ embed, embedBatch? }` instead of a bare `embed` function; loaders that omit `embedBatch` fall back to the previous sequential behaviour, so test fixtures and bespoke implementations keep working unchanged. The `EmbeddingProvider.embedBatch` surface in `@psraghuveer/memento-core` is unchanged and remains optional; existing call sites that go through `embedBatchFallback` automatically pick up the fast path.

### Patch Changes

- Updated dependencies [0dc4716]
  - @psraghuveer/memento-schema@0.11.0
  - @psraghuveer/memento-core@0.12.0

## 0.5.0

### Minor Changes

- af104e5: Close the retrieval-quality and write-safety gaps surfaced by the 2026-05-11 evaluation cycle.

  The branch ships twelve coordinated changes. The headline is retrieval quality: against the same harness (`--n=100,1000 --samples=5`), overall `Recall@1` at N=1000 with vector retrieval enabled moves from **83.6% → 92.7%**, MRR from `0.875 → 0.917`, nDCG@10 from `0.886 → 0.917`. The full +9.1 pp lift is attributable to one structural fix — forgotten/archived rows can now carry embeddings — but the rest of the branch is the foundation that makes the next round of retrieval work cheap: opt-in ranker variants, candidate-arm controls, diversity, projection, write-time guards, batched lookups, and a boot-time warmup hook so the first user-facing query no longer pays the model-init cost.

  **Retrieval pipeline.**

  - **Temporal filters on `memory.search` and `memory.events`.** New optional `createdAtAfter` / `createdAtBefore` (search), `confirmedAfter` / `confirmedBefore` (search), and `since` / `until` (events) input fields, all half-open against the relevant timestamp.
  - **Per-arm candidate thresholds.** New `retrieval.candidate.ftsMinScore` (compares against `|BM25|`, default `0`) and `retrieval.candidate.vectorMinCosine` (default `-1`). Defaults are no-op; flipping them gives operators a small p95 latency win at no cost to recall on the eval corpus (p95 dropped from 184 ms → 161 ms at N=1000 vector-on when both thresholds were raised to `0.65`).
  - **RRF ranker strategy.** New `retrieval.ranker.strategy: 'linear' | 'rrf'` (default `linear`) and `retrieval.ranker.rrf.k` (default `60`). Reciprocal Rank Fusion over the FTS and vector arms; the four baseline arms (confidence, recency, scope, pinned) compose on top exactly as in the linear ranker. RRF is opt-in because at the shipped weights it under-performs linear on this harness (Recall@1 N=1000 vec-on `92.7% → 65.5%`); the strategy is there for hosts that want to tune weights for their own corpus.
  - **MMR diversity post-rank pass.** New `applyMMR` helper in `@psraghuveer/memento-core/retrieval/diversity`, wired into `memory.context` by default (`context.diversity.lambda: 0.7`) and opt-in on `memory.search`. Windowed implementation: the pass runs over the top `limit * 2` head and splices the unmodified tail back, so the latency cost stays bounded. Effect lives in `memory.context`'s top-5 (the survey-style retrieval surface), not in `memory.search` (the lookup surface), and the harness reflects that — search-probe metrics are identical with MMR on vs off.
  - **Supersession demotion when successor co-present.** New `retrieval.ranker.weights.supersedingMultiplier` (default `0.5`, mutable). Multiplies a superseded memory's score when the successor is in the same result set; only fires when callers opt into superseded retrieval via `includeStatuses`. Default `memory.search` (active-only) is unchanged.
  - **Allow embedding of forgotten / archived rows.** `memory.set_embedding` now accepts the three reachable statuses; `embedding.rebuild` accepts a new optional `includeNonActive: boolean` (CLI: `--include-non-active`) to extend its scan beyond active. **This is the structural fix that moves the headline metric.** With it, the `F-forgotten-explicit` probe's `Recall@1` recovers from `0.0% → 100.0%`, lifting the overall composite.

  **Write-time safety.**

  - **Topic-line validation for `preference` and `decision` writes.** New `safety.requireTopicLine` config key (`z.boolean()`, **default `true`**, mutable). `memory.write`, `memory.write_many`, `memory.supersede`, and `memory.extract` reject `preference` / `decision` content whose first non-blank line does not parse as `topic: value` (or `topic = value`). The validator reuses the parser the conflict detector already uses, so write-time gating and retrieval-time conflict detection stay in sync: content that would silently bypass the detector now fails fast at write time with a pointer to the canonical example. Flip the flag to `false` to keep the historical permissive shape.

  **Diagnostics.**

  - **Projection mode on `memory.search`.** New `projection: 'full' | 'summary'` input. **Default is `summary`**, which drops the `breakdown` and `conflicts` per-result objects from the wire shape — typical top-10 payload shrinks by ~30–40% with no loss of the memory body. Callers needing ranking explainability pass `projection: 'full'`. The schema fields stay optional rather than splitting into a union, so existing consumers see the same TS surface.
  - **Near-uniform-ranking hint on `memory.context`.** New `context.hint.uniformSpreadThreshold` (default `0.05`). When the top-K scores cluster within the threshold, the response includes a `hint: 'near-uniform'` diagnostic so callers (or downstream agents) can tell apart "we found one strong match" from "we found ten ambiguous matches."

  **Performance.**

  - **Batched open-conflict lookup in `memory.search`.** When `conflict.surfaceInSearch` is enabled, conflict annotation now issues one `listOpenByMemoryIds` round-trip for the whole page instead of N per-result `list` calls. New `ConflictRepository.listOpenByMemoryIds(ids): ReadonlyMap<string, Conflict[]>` method on the public interface.
  - **Optional embedder warmup at boot.** New optional `warmup?: () => Promise<void>` on the `EmbeddingProvider` interface; `@psraghuveer/memento-embedder-local` implements it by driving its single-flight init. New `embedder.local.warmupOnBoot` config key (`z.boolean()`, default `true`). Bootstrap fires the warmup fire-and-forget after the startup backfill, so the first user-facing query no longer pays the lazy-init cost. Failures are swallowed; the next real `embed()` call surfaces any underlying error.

  **Public API additions.**

  - New input fields on `MemorySearchInputSchema` and `MemoryEventsInputSchema` (temporal filters; `projection`).
  - New optional input field `includeNonActive` on `EmbeddingRebuildInputSchema`.
  - New named exports from `@psraghuveer/memento-core`: `applyMMR` (and types), `rankRRF`, `parseKeyValue` (re-export from conflict module).
  - New method on `ConflictRepository`: `listOpenByMemoryIds`.
  - New optional method on `EmbeddingProvider`: `warmup`.
  - New config keys: `retrieval.candidate.ftsMinScore`, `retrieval.candidate.vectorMinCosine`, `retrieval.ranker.strategy`, `retrieval.ranker.rrf.k`, `retrieval.ranker.weights.supersedingMultiplier`, `context.diversity.lambda`, `context.diversity.maxDuplicates`, `retrieval.diversity.lambda`, `retrieval.diversity.maxDuplicates`, `context.hint.uniformSpreadThreshold`, `safety.requireTopicLine`, `embedder.local.warmupOnBoot`.

  **Behaviour changes.**

  - `memory.search` projection defaults to `'summary'` — smaller wire payload by default. Pass `projection: 'full'` to restore the per-result `breakdown` and `conflicts` fields.
  - `safety.requireTopicLine` defaults to `true`. Existing free-prose `preference` / `decision` writes will be rejected with `INVALID_INPUT` and a pointer to the `topic: value` example until the content is reshaped — or the flag is flipped to `false`.
  - `memory.context` applies MMR diversity at `λ = 0.7` by default. Pass through or override `context.diversity.lambda` to disable (`1.0`) or strengthen (`< 0.7`).

  **Out of scope.**

  - Resolver-state surface on `system.info` / `system.list_scopes` (P2-2 / P2-3). Held pending the resolver subsystem the host wires; the bootstrap does not yet construct a typed `ActiveScopes`. Will land as a follow-up.
  - Materialised `confirm_count` cache (P2-7). Architectural decision class — schema migration plus repo-write coordination plus doctor check is more than one decision and belongs behind a design proposal.
  - Cloud embedders, LLM-driven conflict detection, multi-user surfaces. Unchanged from prior posture.

### Patch Changes

- Updated dependencies [af104e5]
  - @psraghuveer/memento-core@0.11.0
  - @psraghuveer/memento-schema@0.10.0

## 0.4.4

### Patch Changes

- Updated dependencies [7ebe1c6]
  - @psraghuveer/memento-core@0.10.0
  - @psraghuveer/memento-schema@0.9.0

## 0.4.3

### Patch Changes

- Updated dependencies [65e49d3]
  - @psraghuveer/memento-core@0.9.0
  - @psraghuveer/memento-schema@0.8.0

## 0.4.2

### Patch Changes

- Updated dependencies [5479c6a]
  - @psraghuveer/memento-core@0.8.0
  - @psraghuveer/memento-schema@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [1dc5f71]
  - @psraghuveer/memento-core@0.7.0
  - @psraghuveer/memento-schema@0.6.0

## 0.4.0

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

  Plus: a new `'dashboard'` value on `CommandSurface`. Only commands the UI uses today are opted in (read paths + `memory.confirm`/`update`/`forget`, `config.*`, `conflict.list`/`resolve`); everything else (writes, supersede, set*embedding, archive variants, restore, *\_many, conflict.scan, embedding.rebuild, compact.run, memory.context, memory.extract, system.list*tags) returns `INVALID_INPUT` from the dashboard pointing at the CLI. Hono `secureHeaders` (CSP, X-Frame-Options DENY, nosniff, no-referrer); 4 MiB body limit on `/api/commands/*`; static handler now does realpath-based containment; sourcemaps no longer ship in production builds.

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
  - @psraghuveer/memento-core@0.6.0
  - @psraghuveer/memento-schema@0.5.0

## 0.3.1

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

- Updated dependencies [fe72460]
  - @psraghuveer/memento-core@0.5.1

## 0.3.0

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
  - @psraghuveer/memento-core@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [544e96b]
  - @psraghuveer/memento-core@0.4.0
  - @psraghuveer/memento-schema@0.3.0

## 0.2.0

### Minor Changes

- 1fdbf05: Embeddings default-on: flip `retrieval.vector.enabled` to `true`, add `embedding.autoEmbed` config key for fire-and-forget embedding on write, upgrade default model to `bge-base-en-v1.5` (768d), move `@psraghuveer/memento-embedder-local` to a regular dependency, and make the search pipeline degrade gracefully to FTS-only on transient embed failures.

### Patch Changes

- Updated dependencies [1fdbf05]
  - @psraghuveer/memento-core@0.3.0
  - @psraghuveer/memento-schema@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [b64dd5d]
  - @psraghuveer/memento-core@0.2.0
