# @psraghuveer/memento

## 0.9.2

### Patch Changes

- Updated dependencies [f09b009]
  - @psraghuveer/memento-schema@0.14.0
  - @psraghuveer/memento-core@0.17.0
  - @psraghuveer/memento-dashboard@0.5.0
  - @psraghuveer/memento-embedder-local@0.7.2
  - @psraghuveer/memento-server@0.4.2

## 0.9.1

### Patch Changes

- 1a565d2: docs+walkthrough: align Quickstart prose with the 0.9.0 four-prompt init flow

  Two surfaces visible to end users were still describing `memento init` as a three-prompt walkthrough after 0.9.0 added the persona auto-install prompt as the fourth one-keystroke question:

  - **Package README.** `packages/cli/README.md` (the README shown on the npm package page) called out "three one-keystroke setup questions" in two places and titled the post-init step "Paste the persona snippet into your client's custom-instructions slot" — pre-auto-installer wording that no longer matches what `init` actually does.
  - **Printed walkthrough.** The Step 3 heading in `init`'s terminal output (rendered by `renderPersonaSnippetReco` in `packages/cli/src/init-render.ts`) likewise read "Paste the persona snippet into your client's custom-instructions slot", which is misleading immediately after the user has just said `Y` to the auto-install prompt and the persona block was written for them.

  **What changes for users**

  - The package README's Install blurb and Quickstart now describe four interactive setup questions and enumerate the auto-installer's per-client paths (`~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, `~/Documents/Cline/Rules/memento.md`).
  - The Quickstart Step 3 heading on the package README is now "Confirm the persona snippet reaches your assistant"; the body splits into the auto-installed-already path (file-based clients) and the UI-only manual-paste path (Cowork, Claude Desktop, Claude Chat, Cursor User Rules).
  - `init`'s printed Step 3 heading now reads "Confirm the persona snippet reaches your assistant" and the body explicitly acknowledges the auto-installed path before pointing UI-only / skipped clients at the manual paste in `docs/guides/teach-your-assistant.md`.

  No command shape, flag, or exit-code change. No API change. Behavior of the auto-installer itself (added in 0.9.0) is unchanged — only the surrounding prose and the post-run walkthrough headings.

  Internal cleanups landing in the same PR (not user-visible, included here for completeness): ADR-0028 prose updated to describe four prompts; `runInteractivePrompts` JSDoc updated to list all four side effects; `InitPrompter` interface JSDoc updated to "four interactive prompts"; `init-prompts.test.ts` updated to assert the fourth method (`promptInstallPersona`) that PR #78 forgot to wire into the existence-check test.

## 0.9.0

### Minor Changes

- 9a158fd: feat(cli): auto-install the persona snippet into detected clients; client-neutral docs reframe

  Two coupled changes shipping together. The reframe (docs + init walkthrough) acknowledges what testing showed — the MCP `instructions` field (ADR-0026) is optional on the client side and current implementations typically don't surface it to the assistant's system prompt. The new auto-installer collapses the manual "paste this into your client's custom-instructions slot" step into a `y/N` during `memento init` for the subset of clients whose persona slot is a file on disk.

  **Auto-installer (new `packages/cli/src/persona-installer.ts`)**

  A fourth interactive prompt in `memento init` offers to write the persona snippet — sourced from the same `MEMENTO_INSTRUCTIONS` constant the MCP server emits — into every detected file-based client's user-scope custom-instructions file. UI-only clients (Cowork, Claude Desktop, Claude Chat, Cursor User Rules) surface as copy-paste instructions in the renderer.

  Detected targets, by canonical user-scope path:

  - Claude Code → `~/.claude/CLAUDE.md` (loaded into every session per Anthropic's docs)
  - OpenCode → `~/.config/opencode/AGENTS.md`
  - Cline → `~/Documents/Cline/Rules/memento.md`

  Each write is wrapped in HTML-comment markers (`<!-- memento:persona BEGIN v<version> -->` / `<!-- memento:persona END -->`), making the install:

  - **Idempotent.** Re-running `init` with identical content reports `already-current` and no-ops the write.
  - **Updatable in place.** Re-running with new content splices the block out and rewrites — no accumulated drift, no duplicate blocks.
  - **Removable.** The marker bounds let a future `memento persona uninstall` strip the block while leaving surrounding user content intact.

  Detection is filesystem-only — no network calls. A client whose canonical directory doesn't exist on the host is simply skipped (no write, no spurious "if you also use X…" line). The persona content itself reuses `MEMENTO_INSTRUCTIONS` exported from `@psraghuveer/memento-server` so the spine on the wire and the persona on disk never drift.

  The prompt defaults to `Y` and presents an explicit per-target enumeration before asking for consent — the user sees exactly which files will be written and which UI surfaces still need manual paste before confirming.

  **Docs + walkthrough reframe (client-neutral)**

  Every user-facing doc reordered into reliability order — persona first, skill second, spine third — with all client-specific honours/doesn't claims removed. The framing now is:

  - **Persona snippet** = universal, always-on. The only teaching surface guaranteed to land in every client. **Now optionally auto-installed** during `memento init` for file-based clients.
  - **Bundled skill** = load-on-intent enrichment for skill-capable clients.
  - **MCP `instructions` spine** = best-effort future-proofing on the wire. Optional on the client side; implementations vary.

  Files touched (docs + init prose):

  - Root `README.md`, `packages/cli/README.md`, `packages/server/README.md` — three-step quickstart; spine framed as best-effort future-proofing.
  - `docs/guides/teach-your-assistant.md` — surfaces reordered into reliability order; the per-client honours/doesn't matrix removed in favour of neutral single-paragraph framing per surface.
  - `packages/landing/src/App.tsx` + `howto.ts` — quickstart grid expands to three cards; persona snippet block re-titled "the universal always-on teaching surface".
  - `docs/adr/0026-mcp-instructions-as-session-teaching-spine.md` — prose updates; the decision is unchanged. ADR-immutability protects the decision, not the wording.
  - `packages/cli/src/init-render.ts` — Step 3 now opens with the universal persona recommendation; per-target persona-install outcomes render below the existing skill / pack ack block.

  Language is client-neutral throughout — no surface is labelled by which specific clients honour it.

  **Bump rationale**

  - `@psraghuveer/memento` (CLI): **minor** — coherent feature addition (auto-installer) on top of the docs sweep.
  - `@psraghuveer/memento-server`: **patch** — docs-only changes; no behaviour change.

  `pnpm verify` clean. **1612 tests passing** across 118 files (+12 new persona-installer tests on top of the 1600 baseline).

### Patch Changes

- Updated dependencies [9a158fd]
  - @psraghuveer/memento-server@0.4.1

## 0.8.0

### Minor Changes

- c0433c2: Onboarding revamp: spec-compliant session teaching, unified memory write surface, interactive `init`, and a new `verify-setup` command.

  This is a coordinated 0→1 install-journey overhaul shipping across every published package.

  **What's new**

  - **MCP `instructions` on every connect** (ADR-0026). `buildMementoServer` now emits a ~60-line session-start teaching spine as part of the `initialize` handshake. The MCP spec leaves `instructions` optional on the client side and current client implementations vary in whether they surface it to the assistant's system prompt — treat the spine as best-effort future-proofing on the wire. The persona snippet (paste-into-custom-instructions; auto-installed by `memento init` for detected file-based clients in a follow-up release) is the universal always-on teaching surface; the bundled skill is on-intent enrichment for skill-capable clients. The canonical spine body is exported as `MEMENTO_INSTRUCTIONS` from `@psraghuveer/memento-server`; operators can override via `info.instructions`.
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

### Patch Changes

- Updated dependencies [c0433c2]
  - @psraghuveer/memento-server@0.4.0
  - @psraghuveer/memento-core@0.16.0
  - @psraghuveer/memento-schema@0.13.0
  - @psraghuveer/memento-dashboard@0.4.7
  - @psraghuveer/memento-embedder-local@0.7.1

## 0.7.3

### Patch Changes

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

- Updated dependencies [96a62f0]
  - @psraghuveer/memento-core@0.15.0
  - @psraghuveer/memento-embedder-local@0.7.0
  - @psraghuveer/memento-dashboard@0.4.6
  - @psraghuveer/memento-server@0.3.9

## 0.7.2

### Patch Changes

- Updated dependencies [c430d82]
  - @psraghuveer/memento-core@0.14.0
  - @psraghuveer/memento-schema@0.12.1
  - @psraghuveer/memento-dashboard@0.4.5
  - @psraghuveer/memento-embedder-local@0.6.2
  - @psraghuveer/memento-server@0.3.8

## 0.7.1

### Patch Changes

- ab0eca1: Three new bundled packs, plus a graceful-shutdown fix for the SIGINT-during-startup-backfill crash.

  **Three new packs** — `pragmatic-programmer`, `twelve-factor-app`, `google-sre`. High-leverage engineering frameworks shipped as installable packs, each citing the canonical source and translating the original principles into durable preferences/decisions an AI assistant can act on. Pattern matches `engineering-simplicity`: cite the framework, write original engineering applications, CC0-1.0.

  - **`pragmatic-programmer` v0.1.0** — 13 memories adapting Dave Thomas and Andy Hunt's "The Pragmatic Programmer" (Addison-Wesley, 1999; 20th Anniversary Edition, 2019). Covers DRY, orthogonality, reversibility, tracer bullets, broken windows, programming by coincidence, design by contract, three-strikes refactoring, design-for-testability.
  - **`twelve-factor-app` v0.1.0** — 13 memories adapting Adam Wiggins and the Heroku team's Twelve-Factor App methodology (https://12factor.net, 2011). One memory per factor: codebase, dependencies, config, backing services, build/release/run, processes, port binding, concurrency, disposability, dev/prod parity, logs, admin processes — plus a framework-attribution fact.
  - **`google-sre` v0.1.0** — 11 memories adapting the Google SRE corpus ("Site Reliability Engineering" 2016 and "The Site Reliability Workbook" 2018, https://sre.google/books/). Covers embrace-risk, SLOs-before-SLAs, error budgets, toil reduction, blameless postmortems, the four golden signals, simplicity as a reliability property, alert-on-symptoms, hope-is-not-a-strategy, automated reversible releases.

  Install with `memento pack install <id>`; uninstall with `memento pack uninstall <id> --confirm`.

  **Graceful shutdown** — `MementoApp.shutdown()` is a new async method on the `MementoApp` handle that awaits the in-flight startup embedding backfill (ADR-0021) up to a configurable grace window, then runs the synchronous `close()`. Every lifecycle command (`dashboard`, `serve`, `status`, `doctor`, `init`, `backup`, `import`, `pack`, `context`, registry adapter) now calls `await app.shutdown()` in its `finally` block instead of `app.close()`.

  Without it, Ctrl-C during the backfill window tears down the embedder's ONNX worker threads mid-inference and aborts the process with `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument`. The race is most reachable on `memento dashboard` and `memento serve` (long-lived signal-driven processes that wait on SIGINT) but theoretically present on every command. Graceful drain closes the window.

  The synchronous `close()` is kept on the interface for embedded callers and tests that coordinate teardown another way. Hosts that run signal-driven lifecycle commands should prefer `shutdown()`.

  New config key `embedding.startupBackfill.shutdownGraceMs` (number, default 3000, mutable, range 0–60_000) sets the grace window. Set to 0 to skip the wait entirely (back to fire-and-forget, only safe when the host coordinates teardown another way).

  **Bump-type framework** — `.changeset/README.md` now has a "Choosing the bump type" section with two conventions (library packages follow standard semver on public exports; the CLI bumps `minor` only for coherent feature launches and `patch` for everything else additive). Pointers in `CONTRIBUTING.md` and `skills/memento-dev/SKILL.md` so contributors and AI agents both apply it consistently.

- Updated dependencies [ab0eca1]
  - @psraghuveer/memento-core@0.13.0
  - @psraghuveer/memento-schema@0.12.0
  - @psraghuveer/memento-dashboard@0.4.4
  - @psraghuveer/memento-embedder-local@0.6.1
  - @psraghuveer/memento-server@0.3.7

## 0.7.0

### Minor Changes

- 0dc4716: Make Memento more usable for AI-assisted memory work — clearer write-side contract, stronger read-side recall, and faster batched embeddings.

  **Write side — distillation contract clarity.** The MCP tool description on `extract_memory` flags the candidate-shape difference from `write_memory` (flat `kind` enum, top-level `rationale`/`language`), states the `topic: value\n\nprose` requirement for `preference`/`decision` kinds, and notes the `storedConfidence: 0.8` async-default. An inline example shows four kinds with the correct field placement — including a `preference` candidate that opens with the required topic-line and a `decision` candidate with top-level `rationale`. `TagSchema` emits an actionable error message listing the allowed charset instead of a bare "Invalid". The skill, persona-snippet guide, and landing-page persona-snippet mirror carry a "Distillation craft" section that frames the task as retrieval indexing (not summarisation) and codifies six rules: preserve specific terms (proper nouns, identity qualifiers, dates, named entities); capture facts about every named participant, not only the user (a friend the user mentions, a colleague, a co-speaker — facts they share about themselves AND the user's observations about them are both worth indexing, attributed to the right named person); emit a candidate for every dated event with the date resolved against the session anchor; capture precursor actions alongside outcomes ("researched X" AND "chose Y" as separate candidates, since future questions can target either); don't squash enumerations into category labels; bias toward inclusion (the server dedups).

  **Read side — porter stemming for FTS5.** `memories_fts` is now built with `tokenize='porter unicode61'` instead of the default `unicode61`. The chain has unicode61 split + diacritic-fold first, then porter stem the resulting tokens — so "colleague", "colleagues", and "colleague's" share a stem and match each other in keyword search, and "bake" matches "baking" / "baked" / "bakes". Non-ASCII content still tokenises correctly because unicode61 runs first. The `retrieval.fts.tokenizer` config key now defaults to `porter` and is documented as honoured by the FTS index (previously declared but ignored). Migration 0008 drops and rebuilds `memories_fts` with the new tokenizer, preserving stable rowids via the `memories_fts_map` table; the runner applies it on first server start after upgrade, so no operator action is required. Recall on natural-language queries — where the speaker's wording and the future question's wording differ in plural, verb form, or possessive — improves at the FTS layer instead of depending on vector search to rescue every morphological miss.

  **Embedder perf — real batched feature-extraction.** `@psraghuveer/memento-embedder-local`'s `embedBatch` now uses transformers.js v3's array-input pipeline, which runs one forward pass for the whole batch instead of looping per text. Numerically identical to the single-call form (verified row-by-row against the same input). Measured ~1.8× speedup on a 3-input batch with `bge-base-en-v1.5` on CPU; the speedup grows with batch size because tokenisation and pipeline setup amortise across the batch. The loader contract now returns `{ embed, embedBatch? }` instead of a bare `embed` function; loaders that omit `embedBatch` fall back to the previous sequential behaviour, so test fixtures and bespoke implementations keep working unchanged. The `EmbeddingProvider.embedBatch` surface in `@psraghuveer/memento-core` is unchanged and remains optional; existing call sites that go through `embedBatchFallback` automatically pick up the fast path.

### Patch Changes

- Updated dependencies [0dc4716]
  - @psraghuveer/memento-schema@0.11.0
  - @psraghuveer/memento-core@0.12.0
  - @psraghuveer/memento-embedder-local@0.6.0
  - @psraghuveer/memento-dashboard@0.4.3
  - @psraghuveer/memento-server@0.3.6

## 0.6.3

### Patch Changes

- 1f7b514: Bake the `mcpName: "com.runmemento/memento"` field into the published tarball so the official MCP Registry can verify this package backs the canonical server entry. The field was added in #58 (ADR-0022) but missed the prior npm publish; this patch ships it. No runtime behavior change.

## 0.6.2

### Patch Changes

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

- Updated dependencies [af104e5]
  - @psraghuveer/memento-core@0.11.0
  - @psraghuveer/memento-schema@0.10.0
  - @psraghuveer/memento-embedder-local@0.5.0
  - @psraghuveer/memento-dashboard@0.4.2
  - @psraghuveer/memento-server@0.3.5

## 0.6.1

### Patch Changes

- 7ebe1c6: Fix install-time embeddings (sync) + add startup backfill for orphan recovery (ADR-0021).

  The 0.6.0 packs launch shipped a defect that the 0.6.1 hotfix only partially closed: pack-installed memories silently landed at `embeddingStatus: pending` because the post-write `afterWrite` chain — even after we wired it — runs `auto-embed` as fire-and-forget. The CLI process (or the MCP server) often exited before the async embed work resolved, leaving every `pack.install` and every `memento import` with broken vector retrieval until the user ran `embedding.rebuild` by hand. An audit found `importSnapshot` had the same gap pre-dating packs entirely (it writes via raw SQL and never hit the hook chain at all).

  Three changes, one PR:

  - **`pack.install` now embeds synchronously.** A new `PackCommandDeps.embedAndStore` callback runs `provider.embedBatch` over every freshly-written memory and persists vectors via `repo.setEmbedding` before the handler resolves. Conflict detection stays fire-and-forget per ADR-0005; only auto-embed becomes synchronous, and only on this install-time surface.
  - **`importSnapshot` embeds post-commit.** A new `ImportOptions.embedAndStore` callback fires after the import transaction commits (outside the lock) on freshly-inserted memories whose artefact didn't carry pre-computed vectors. Same partial-failure policy: never throws, recovery via `embedding.rebuild`. The CLI's `memento import` lifecycle composes the callback from the wired `EmbeddingProvider`.
  - **Bootstrap kicks off a bounded startup backfill.** When an embedder is wired and `embedding.startupBackfill.enabled` is true (default), `createMementoApp` runs `reembedAll` once at boot — off-thread (does not block first request), bounded by `embedding.startupBackfill.maxRows` (default 1000), best-effort. Drains orphan pending state from any source: previous-session crashes, prior buggy install paths, manually-toggled `embedding.autoEmbed`, imports that pre-date this PR.

  Public API additions:

  - `embedAndStore(memories, provider, repo, actor)` and `EmbedAndStoreResult` exported from `@psraghuveer/memento-core/embedding`.
  - `MementoApp.embeddingProvider?: EmbeddingProvider` — the wired provider, exposed so hosts can compose post-write batch operations.
  - `PackCommandDeps.embedAndStore` callback (optional).
  - `ImportOptions.embedAndStore` callback (optional).
  - New immutable config keys `embedding.startupBackfill.enabled` (bool, default `true`) and `embedding.startupBackfill.maxRows` (int, default `1000`).

  Behavioural impact: `pack.install` and `memento import` now block on embedder readiness. With the model warm, the install latency cost is typically a few seconds. With a fresh machine and no cached model, the first install downloads 435 MB of ONNX before returning — typically 5–10 minutes on average broadband. We accept this because deferring the cost behind fire-and-forget made the failure invisible rather than absent. Conversational write paths (`memory.write`, `memory.write_many`, `memory.extract`, `memory.supersede`) are unchanged — they remain fire-and-forget; the startup backfill heals their orphans on next boot.

  Closes the cold-start gap end-to-end: a fresh `npm i -g @psraghuveer/memento && memento pack install <id>` produces a store with working semantic recall on the first session.

- Updated dependencies [7ebe1c6]
  - @psraghuveer/memento-core@0.10.0
  - @psraghuveer/memento-schema@0.9.0
  - @psraghuveer/memento-dashboard@0.4.1
  - @psraghuveer/memento-embedder-local@0.4.4
  - @psraghuveer/memento-server@0.3.4

## 0.6.0

### Minor Changes

- 65e49d3: Add Memento Packs — installable YAML bundles of memories that close the cold-start gap (an empty memory store has no value).

  - `memento pack install <id>` seeds your store from a curated bundle. One pack ships in this release: `engineering-simplicity` — 11 memories adapted from John Maeda's _The Laws of Simplicity_ with original engineering applications, CC0-1.0. Use `memento pack list` to see what's installed and `memento pack preview <id>` to inspect a pack before committing.
  - Three install sources: bundled (`memento pack install engineering-simplicity`), local file (`--from-file ./pack.yaml`), or HTTPS URL (`--from-url https://...`). URL fetches are HTTPS-only, capped at `packs.maxPackSizeBytes` (default 1 MiB), and time out at `packs.urlFetchTimeoutMs` (default 10s). Disable URL installs with `packs.allowRemoteUrls=false`.
  - Bundled lookups support omitting `--version`: the resolver scans the pack directory and picks the highest semver, with stable beating prerelease per semver §11.
  - Drift detection is built in. Re-installing the same version with edited content fails fast with `PACK_VERSION_REUSED`; bump the version (e.g. `v0.1.0` → `v0.1.1`) to ship changes. Cosmetic edits to pack-level metadata (title, description, license, tags) don't trigger drift.
  - Provenance is the canonical tag `pack:<id>:<version>`. `memento memory list --tag pack:engineering-simplicity:0.1.0` shows exactly what a pack contributed; `memento pack uninstall <id>` removes it via `memory.forget_many`. The `pack:` prefix is reserved — user writes can't forge it.
  - Author your own with `memento pack create` — interactive prompts walk through filtering existing memories into a YAML pack, or pass flags for non-interactive use. The format is `memento-pack/v1`; full authoring guide at [docs/guides/packs.md](https://github.com/veerps57/memento/blob/main/docs/guides/packs.md), JSON Schema at [docs/reference/pack-schema.json](https://github.com/veerps57/memento/blob/main/docs/reference/pack-schema.json).
  - The dashboard gains a `/packs` tab: browse installed packs, preview a pack's memories, install or uninstall via the UI — same engine as the CLI behind it.

  Design rationale: [ADR-0020](https://github.com/veerps57/memento/blob/main/docs/adr/0020-memento-packs.md).

### Patch Changes

- Updated dependencies [65e49d3]
  - @psraghuveer/memento-core@0.9.0
  - @psraghuveer/memento-schema@0.8.0
  - @psraghuveer/memento-dashboard@0.4.0
  - @psraghuveer/memento-embedder-local@0.4.3
  - @psraghuveer/memento-server@0.3.3

## 0.5.4

### Patch Changes

- 738c850: Polish the npm package page and declare the Node engine.

  - The published `README.md` is now marketing-grade — opens with the project tagline + link to runmemento.com, includes the install command, the three-step Quickstart, and a feature summary, with the architectural reference preserved as a footer. Replaces the previous 928-byte package-internal reference, which was fine in-repo but didn't help anyone landing on npmjs.com from a search result. All internal links are now absolute GitHub URLs so they work when rendered on the npm page (relative paths 404 from npmjs.com).
  - `engines.node` is now declared as `>=22.11.0`, matching the root workspace and `.nvmrc`. npm will surface a clear engine warning on incompatible installs instead of failing at runtime. No behavioural change for in-range Node versions — this just documents what was already required.
  - `keywords` expanded from 7 to 20 entries — added `ai-memory`, `ai-assistant`, `mcp-server`, `model-context-protocol`, `llm`, `llm-memory`, `claude`, `claude-code`, `cursor`, `copilot`, `cline`, `opencode`, `aider`. Improves npm-search ranking on the queries developers actually type when looking for an MCP-native memory layer; no runtime impact.

## 0.5.3

### Patch Changes

- Updated dependencies [5479c6a]
  - @psraghuveer/memento-core@0.8.0
  - @psraghuveer/memento-schema@0.7.0
  - @psraghuveer/memento-dashboard@0.3.0
  - @psraghuveer/memento-embedder-local@0.4.2
  - @psraghuveer/memento-server@0.3.2

## 0.5.2

### Patch Changes

- ea9aa48: Onboarding-flow polish + new `memento skill-path` command.

  - `memento skill-path` prints the absolute path of the staged Memento skill bundle on stdout, designed for shell embedding: `cp -R "$(memento skill-path)" ~/.claude/skills/`. Always emits the bare path even off-TTY (so `$(…)` substitution works inside scripts and pipes); the structured envelope is opt-in via `--format json`. Returns `NOT_FOUND` (exit 3) when the bundle isn't staged, with `details.suggestedTarget` preserved for callers.
  - `memento init`'s walkthrough is now framed as three explicit numbered steps — _Initialize Memento_ / _Connect your AI client_ / _Teach your assistant when to use Memento_ — matching the README, the landing page, and `docs/guides/mcp-client-setup.md`. Step 3 always renders, falling back to a generic persona-snippet pointer when the rendered client set has no skill-capable client (instead of silently dropping the section).
  - The footer now suggests `memento doctor --mcp` (the variant that actually scans client config files) and explicitly tells users to **restart their AI client** after pasting — the missing nudge that was the most common "I pasted, asked a question, got nothing" failure.
  - The `supportsSkills` flag on every registered client (`init-clients.ts`) is now the single source of truth for which clients load Anthropic-format skills; every other surface phrases the choice generically (_"if your client loads Anthropic-format skills"_ / _"if it doesn't"_) so the copy doesn't drift as the ecosystem moves. Today every registered client (Claude Code, Claude Desktop, Cursor, VS Code, OpenCode) is skill-capable.
  - The npm tarball gets a `prepack` insurance hook that re-runs `copy-skills.mjs`, so `npm pack` and `npm publish` can never ship a stale or missing skill bundle regardless of release workflow.

## 0.5.1

### Patch Changes

- Updated dependencies [1dc5f71]
  - @psraghuveer/memento-core@0.7.0
  - @psraghuveer/memento-schema@0.6.0
  - @psraghuveer/memento-dashboard@0.2.1
  - @psraghuveer/memento-embedder-local@0.4.1
  - @psraghuveer/memento-server@0.3.1

## 0.5.0

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
  - @psraghuveer/memento-server@0.3.0
  - @psraghuveer/memento-dashboard@0.2.0
  - @psraghuveer/memento-embedder-local@0.4.0

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

- Updated dependencies [d70b151]
  - @psraghuveer/memento-core@0.5.2
  - @psraghuveer/memento-schema@0.4.1
  - @psraghuveer/memento-dashboard@0.1.3

## 0.4.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [fe72460]
  - @psraghuveer/memento-core@0.5.1
  - @psraghuveer/memento-embedder-local@0.3.1
  - @psraghuveer/memento-dashboard@0.1.2

## 0.3.3

### Patch Changes

- 0186ea0: Add `@psraghuveer/memento-dashboard` and the `memento dashboard` lifecycle command, and fix `memento init` failing when the user deleted only the main `memento.db` and left the SQLite WAL/SHM sidecars behind.

  ## The dashboard

  The new sibling package ships a local-first web UI for browsing, auditing, and curating your Memento store. Every named route lands as a real, functional view rather than a placeholder:

  - **`~/overview`** — landing page with active count, last write, vector retrieval status, open conflicts; kind breakdown; scope distribution.
  - **`~/memory`** — browse with filter chips (status, kind, pinned), search box wired to `memory.search` (FTS + vector when enabled), sort by `lastConfirmedAt`, decay-aware effective-confidence meter on every row, click-through to detail.
  - **`~/memory/$id`** — full content with sensitive-reveal toggle, supersession chain (up / down links), audit timeline (`memory.events` for that id with type-pill colour coding and per-event payload summary), provenance (created, last confirmed, stored vs. effective confidence), pin / confirm / forget actions.
  - **`~/conflicts`** — pending conflicts triaged as side-by-side memory cards with the four `conflict.resolve` actions (accept-new, accept-existing, supersede, ignore), evidence detail toggle, "re-scan last 24h" button.
  - **`~/audit`** — global activity feed via the id-less mode of `memory.events`, with type filters and deep links to each memory.
  - **`~/config`** — every registered config key grouped by dotted prefix, with current value, source layer (default / startup / runtime), mutability flag, per-key history (`config.history`), and a "copy as `memento config set` command" snippet for friction-free editing via the CLI.
  - **`~/system`** — doctor-style probes (database, vector retrieval, embedder, schema version, last write, version) plus a status-count tile row.

  Plus two cross-cutting pieces:

  - **Cmd-K command palette** — global ⌘K / Ctrl-K overlay with three modes: live `memory.search` as you type (debounced), `>` prefix for page navigation, `:` prefix for direct memory open by ULID. Read-only; destructive verbs stay on the detail page where the full context lives.
  - **Inline config editor** on `~/config` — typed editors per row (boolean → checkbox, number → number input, string → text input, otherwise → JSON textarea), inferred from the current value's runtime type. Save calls `config.set`; a "reset to default" button (visible when the source is `runtime`) calls `config.unset`. Engine-side `INVALID_INPUT` and `IMMUTABLE` errors render inline. Known immutable keys are read-only client-side as a UX shortcut, with the server's `IMMUTABLE` response as the canonical fallback.

  Architecturally, the dashboard is a third adapter on the existing command registry — every read and mutation goes through `executeCommand(...)` over the same surface MCP and CLI use. **No new MCP commands, no new registered CLI commands, no new config keys, no schema migrations.** Every view is a thin projection of one or more existing registry commands. See [ADR-0018](docs/adr/0018-dashboard-package.md) for the full rationale.

  Mobile-responsive from day one — every view stacks cleanly at narrow widths and the chrome collapses into a header-toggled drawer.

  The CLI gains one new lifecycle command, `memento dashboard`, that opens a `MementoApp`, mounts the Hono server bound to `127.0.0.1` on a random port, opens the user's browser, and blocks until SIGINT. The dashboard package is loaded via dynamic import so non-dashboard invocations (`memento serve`, `memento doctor`, etc.) do not pay the load cost. The lifecycle command accepts `--port`, `--host 127.0.0.1|localhost`, and `--no-open`; it is print-free on stdout during operation so machine-readable consumers can capture the post-shutdown snapshot via `--format json`.

  `KNOWN_LIMITATIONS.md` and `AGENTS.md` were updated to reflect the reversal of the prior "Web UI out of scope" stance. A TUI remains out of scope; the dashboard covers the same need.

  Stack:

  - Server: Hono on Node, in-process with the engine, with a generic `/api/commands/:name` surface that wraps every registered command.
  - UI: React + Tailwind + TanStack Query / Router, built by Vite into a static SPA. Theme is "warm dark default with one amber accent and one cyan-teal accent," monospace-leaning typography (Inter + JetBrains Mono via `@fontsource/*` for offline-first fonts).
  - Security: same-origin guard on mutating requests; the server binds to `127.0.0.1` only.

  ## Fix: `memento init` cleans orphan WAL/SHM sidecars

  Memento opens its database in WAL mode (`PRAGMA journal_mode = WAL`), which produces three files alongside the main `.db`: `memento.db-wal`, `memento.db-shm`, and (rarely) `memento.db-journal`. SQLite owns the sidecars and recovers from them on next open. If the user removed only `memento.db` (`rm memento.db`), the sidecars survived; the next open created an empty `.db`, set WAL mode, and SQLite tripped on a WAL whose contents did not match the new file. The recovery surfaced as a generic, misleading `STORAGE_ERROR: failed to open database … disk I/O error`.

  `memento init` now detects the half-deleted-store state — main `.db` absent, sidecars present — and removes the orphan sidecars before opening the database. The cleanup is observable in the snapshot as a new `stale-wal-sidecars` `InitCheck` so the operator sees what happened on their behalf rather than a silent surprise.

  The cleanup is sound only when the main `.db` is absent; when the file exists the sidecars belong to SQLite and the check is a no-op (regression test pins this so a future change cannot accidentally over-reach).

  Workaround for prior versions: `rm ~/.local/share/memento/memento.db-wal ~/.local/share/memento/memento.db-shm`, then re-run `memento init`.

- Updated dependencies [0186ea0]
  - @psraghuveer/memento-dashboard@0.1.0

## 0.3.2

### Patch Changes

- a9826e1: Add the Memento skill bundle and surface it from `memento init`.

  The new bundle (`skills/memento/SKILL.md`) teaches Anthropic-skill-capable
  clients — Claude Code, Claude Desktop, Cowork — when to call the Memento
  MCP tools (`write_memory`, `extract_memory`, `get_memory_context`,
  `confirm_memory`, `supersede_memory`, `forget_memory`, …), how to choose
  scope and kind, when to supersede instead of update, and how to handle
  conflicts and sensitive content. Closes the adoption gap from ADR-0016
  without requiring users to hand-paste a persona snippet. Clients that do
  not load Anthropic skills (Cursor, VS Code Agent, OpenCode) continue to
  use the persona-snippet alternative in
  `docs/guides/teach-your-assistant.md`.

  `memento init` now ships an "── Memento skill (optional) ──" section
  gated on the rendered client set: shown when at least one
  skill-capable client is present, suppressed otherwise. The skill
  source is staged into the npm tarball by a build-time
  `copy-skills.mjs` script so `npx`-only users get a real absolute
  path to copy from. `init` is still print-only by design — the
  section lists a `cp -R …` command rather than mutating the user's
  skills directory.

  The `InitSnapshot` contract grows one new field, `skill: SkillInstallInfo`
  — additive — and `ClientSnippet` grows `supportsSkills: boolean`. No
  existing fields change shape.

## 0.3.1

### Patch Changes

- Updated dependencies [d1b6aaf]
  - @psraghuveer/memento-schema@0.4.0
  - @psraghuveer/memento-core@0.5.0
  - @psraghuveer/memento-embedder-local@0.3.0
  - @psraghuveer/memento-server@0.2.1

## 0.3.0

### Minor Changes

- 544e96b: Add memory.context and memory.extract commands (ADR-0016)

  - `memory.extract`: batch extraction with embedding-based dedup (skip/supersede/write) and configurable confidence defaults
  - `memory.context`: query-less ranked retrieval for session-start context injection
  - ~13 new config keys for extraction thresholds, context limits, and ranking weights
  - Remove dead code (`commands/memory/errors.ts`)
  - Harden test coverage across bulk commands, retrieval pipeline, CLI lifecycle, and doc renderers

### Patch Changes

- Updated dependencies [544e96b]
  - @psraghuveer/memento-core@0.4.0
  - @psraghuveer/memento-schema@0.3.0
  - @psraghuveer/memento-server@0.2.0
  - @psraghuveer/memento-embedder-local@0.2.1

## 0.2.1

### Patch Changes

- f099020: Fix embedder resolution failure in global npm installs by removing the `createRequire` gate that silently returned `undefined` when the package was actually present.

## 0.2.0

### Minor Changes

- 1fdbf05: Embeddings default-on: flip `retrieval.vector.enabled` to `true`, add `embedding.autoEmbed` config key for fire-and-forget embedding on write, upgrade default model to `bge-base-en-v1.5` (768d), move `@psraghuveer/memento-embedder-local` to a regular dependency, and make the search pipeline degrade gracefully to FTS-only on transient embed failures.

### Patch Changes

- Updated dependencies [1fdbf05]
  - @psraghuveer/memento-core@0.3.0
  - @psraghuveer/memento-schema@0.2.0
  - @psraghuveer/memento-embedder-local@0.2.0
  - @psraghuveer/memento-server@0.1.3

## 0.1.3

### Patch Changes

- Updated dependencies [b64dd5d]
  - @psraghuveer/memento-core@0.2.0
  - @psraghuveer/memento-embedder-local@0.1.1
  - @psraghuveer/memento-server@0.1.2

## 0.1.2

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
  - @psraghuveer/memento-core@0.1.1
  - @psraghuveer/memento-server@0.1.1

## 0.1.1

### Patch Changes

- c6e2d95: Fix `memento init` failing on fresh hosts where the platform data directory (e.g. `~/.local/share/memento/` or `%LOCALAPPDATA%\memento\`) did not yet exist. `init` now creates the parent directory recursively before the writability check, so the first run on a brand-new laptop succeeds.
