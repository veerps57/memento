# @psraghuveer/memento-schema

## 0.11.0

### Minor Changes

- 0dc4716: Make Memento more usable for AI-assisted memory work — clearer write-side contract, stronger read-side recall, and faster batched embeddings.

  **Write side — distillation contract clarity.** The MCP tool description on `extract_memory` flags the candidate-shape difference from `write_memory` (flat `kind` enum, top-level `rationale`/`language`), states the `topic: value\n\nprose` requirement for `preference`/`decision` kinds, and notes the `storedConfidence: 0.8` async-default. An inline example shows four kinds with the correct field placement — including a `preference` candidate that opens with the required topic-line and a `decision` candidate with top-level `rationale`. `TagSchema` emits an actionable error message listing the allowed charset instead of a bare "Invalid". The skill, persona-snippet guide, and landing-page persona-snippet mirror carry a "Distillation craft" section that frames the task as retrieval indexing (not summarisation) and codifies six rules: preserve specific terms (proper nouns, identity qualifiers, dates, named entities); capture facts about every named participant, not only the user (a friend the user mentions, a colleague, a co-speaker — facts they share about themselves AND the user's observations about them are both worth indexing, attributed to the right named person); emit a candidate for every dated event with the date resolved against the session anchor; capture precursor actions alongside outcomes ("researched X" AND "chose Y" as separate candidates, since future questions can target either); don't squash enumerations into category labels; bias toward inclusion (the server dedups).

  **Read side — porter stemming for FTS5.** `memories_fts` is now built with `tokenize='porter unicode61'` instead of the default `unicode61`. The chain has unicode61 split + diacritic-fold first, then porter stem the resulting tokens — so "colleague", "colleagues", and "colleague's" share a stem and match each other in keyword search, and "bake" matches "baking" / "baked" / "bakes". Non-ASCII content still tokenises correctly because unicode61 runs first. The `retrieval.fts.tokenizer` config key now defaults to `porter` and is documented as honoured by the FTS index (previously declared but ignored). Migration 0008 drops and rebuilds `memories_fts` with the new tokenizer, preserving stable rowids via the `memories_fts_map` table; the runner applies it on first server start after upgrade, so no operator action is required. Recall on natural-language queries — where the speaker's wording and the future question's wording differ in plural, verb form, or possessive — improves at the FTS layer instead of depending on vector search to rescue every morphological miss.

  **Embedder perf — real batched feature-extraction.** `@psraghuveer/memento-embedder-local`'s `embedBatch` now uses transformers.js v3's array-input pipeline, which runs one forward pass for the whole batch instead of looping per text. Numerically identical to the single-call form (verified row-by-row against the same input). Measured ~1.8× speedup on a 3-input batch with `bge-base-en-v1.5` on CPU; the speedup grows with batch size because tokenisation and pipeline setup amortise across the batch. The loader contract now returns `{ embed, embedBatch? }` instead of a bare `embed` function; loaders that omit `embedBatch` fall back to the previous sequential behaviour, so test fixtures and bespoke implementations keep working unchanged. The `EmbeddingProvider.embedBatch` surface in `@psraghuveer/memento-core` is unchanged and remains optional; existing call sites that go through `embedBatchFallback` automatically pick up the fast path.

## 0.10.0

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

## 0.9.0

### Minor Changes

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

## 0.8.0

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

## 0.7.0

### Minor Changes

- 5479c6a: Dashboard stress-test fix pass + engine corrections it surfaced.

  A multi-round audit of the v0 dashboard surfaced eight visible bugs and a stack of UX/copy issues. Closing them required matching engine work: a broken conflict-scan surface, an audit-log gap that made every first-time config edit read as `null → x`, a missing dedup invariant in conflict detection, and three new `system.info` fields. The dashboard was largely rewritten on top of the corrected engine surface — every read view, the inline config editor, the ⌘K palette, the system & health page, and the auth-error UX shipped together so the user-visible polish lands as one coherent change rather than a flurry of single-line PRs.

  Functional behaviour on the happy path is unchanged outside the dashboard. Existing CLI / MCP callers see the same output shapes — the new `system.info` fields are additive, the new `ConfigSetInput.priorEffectiveValue` parameter is optional and back-compat (legacy callers that don't pass it keep their existing oldValue=null semantics), and the new `ConflictRepository.openPartners` method extends the interface without changing the existing five.

  **Conflict detection** (`@psraghuveer/memento-core`)

  - `conflict.scan` is now exposed on the dashboard surface so the conflicts page's "re-scan (24h)" button actually works. Previously the click returned `INVALID_INPUT — Command 'conflict.scan' is not exposed on the dashboard surface`.
  - The detector now skips candidates that already share an open conflict with the memory being scanned (either direction). Without this, every press of `re-scan (24h)` and every redundant post-write hook fire inserted a duplicate row for the same logical pair. Observable in the dashboard's overview tile as a count that grew monotonically with the number of clicks. New `ConflictRepository.openPartners(memoryId)` returns the partner-id set in one query; the detector seeds an in-memory mutable copy at the top of the run so newly-opened pairs aren't re-opened later in the same scan.
  - `conflict.scan` in `since` mode now reports `scanned` as the number of memories processed, not the candidate-pairing count summed across them. Re-runs over a 5,000-memory corpus used to print `scanned 68413 memories` (the work the detector did, not the size of the haystack); now they print the actual memories processed.

  **Config audit log** (`@psraghuveer/memento-core`, `@psraghuveer/memento-schema`)

  `config.set` and `config.unset` accept an optional `priorEffectiveValue` field that the engine plumbs from `configStore.entry(key).value` at the command-handler layer. When no prior event exists for the key, OR when the latest event was an `unset` (i.e. the runtime override layer is empty), the audit `oldValue` records the engine's effective value — typically the schema default — instead of literal `null`. The dashboard's per-key history view now reads `100 → 42 by cli` for the first-time edit instead of the previous `null → 42`. Legacy callers that don't pass `priorEffectiveValue` keep the original oldValue=null behaviour.

  `@psraghuveer/memento-schema` exports a new `IMMUTABLE_CONFIG_KEY_NAMES` constant — the snapshot of every key flagged `mutable: false` in `CONFIG_KEYS`. The dashboard's config editor consumes this directly so its IMMUTABLE_KEYS gate cannot drift from the engine; a structural test in `packages/schema/test/config-keys.test.ts` pins the relationship.

  **`system.info` additions** (`@psraghuveer/memento-core`, `@psraghuveer/memento-schema`)

  Three new top-level fields on the output schema:

  - `openConflicts: number` — exact aggregate from `SELECT COUNT(*) FROM conflicts WHERE resolved_at IS NULL`. The dashboard's overview tile now reads this directly instead of counting a paged `conflict.list` response capped at `conflict.list.maxLimit`. The previous `1,000+` capped display is gone; resolving a conflict decrements the value monotonically through the existing query-cache invalidation path.
  - `runtime: { node, modulesAbi, nativeBinding: 'ok' }` — process-level health subset of `memento doctor`. `nativeBinding` is always `'ok'` because reaching the handler implies the better-sqlite3 .node addon loaded successfully. Powers the dashboard's `~/system` `node` and `native binding` probes.
  - `scrubber: { enabled }` — resolved `scrubber.enabled` config. Surfaces the write-path redaction master switch on `~/system` so the operator can confirm the safety net is active. The key remains pinned at server start (`mutable: false`); the boolean here just mirrors the resolved value the engine is actually applying to writes.

  The handler description metadata is updated to mention the new fields. Reference docs (`docs/reference/mcp-tools.md`, `docs/reference/cli.md`) regenerated.

  **Dashboard surface** (`@psraghuveer/memento-dashboard`)

  The package gets a behaviour + visual sweep on the v0 routes:

  - **Re-scan button works.** Driven by the engine's `conflict.scan` surface fix.
  - **Inline config editor.**
    - The Reset (config.unset) button now renders for runtime overrides — i.e. when `entry.source` is `cli` or `mcp`. The previous predicate compared against the literal `'runtime'`, which is not a member of `ConfigSourceSchema`; the button never rendered.
    - `inferEditorType` treats `null` on the known string-or-null keys (`user.preferredName`, `export.defaultPath`, `embedder.local.cacheDir`) as `'string'`. The previous fallback to JSON forced users to type `"Raghu"` (with quotes) to set their preferred name; bare names failed `JSON.parse`. Empty drafts on these keys are saved as `null` so the field can be cleared without an explicit `config.unset`.
    - `IMMUTABLE_KEYS` now derives from `IMMUTABLE_CONFIG_KEY_NAMES`. Four keys (`embedder.local.timeoutMs`, `embedder.local.cacheDir`, `scrubber.enabled`, `scrubber.rules`) used to render an editor and surface `IMMUTABLE` only on save.
    - Local `ConfigSource` TypeScript type widened to match the schema's actual enum (`default | user-file | workspace-file | env | cli | mcp`); the previous `'default' | 'startup' | 'runtime'` was wrong.
  - **Auth-error UX.** A new `TokenMissingPanel` component renders uniformly across every route when the launch token is missing or rejected. Detection lives in the API client (`callCommand`) which short-circuits to a synthetic `AUTH_REQUIRED` code; the app shell subscribes to the React-Query cache and replaces the active route with the panel. Replaces the seven different `failed: …` prefixes that used to surface on each route.
  - **Pagination.** `memory.list`, `memory.events`, `conflict.list`, and the memory-detail audit timeline get a "load next 100" affordance up to the engine's `*.maxLimit` ceiling (1,000 by default). The hooks use `keepPreviousData` so the page doesn't snap to the top during the next fetch. State resets when filters change.
  - **Filter chips.** Status and kind on `~/memory` are now multi-select sets. The engine takes a single optional `kind`/`status`, so the dashboard sends a wire-level filter only when one chip is active and narrows the rest client-side. Status chips refuse to deselect the last-remaining chip (a zero-status filter is ambiguous without an `all` chip; the four statuses always cover the universe).
  - **Mutation invalidation.** `useSetConfig` / `useUnsetConfig` invalidate `system.info` so the wordmark refreshes after a `user.preferredName` edit. `useResolveConflict` and `useScanConflicts` invalidate `system.info` so the overview tile decrements after triage. Memory mutations also invalidate `system.list_scopes`.
  - **Visual polish.** Overview rows share a `ACROSS ALL SCOPES` / `BY STATUS` header shape with no per-tile subtexts. `BY STATUS` shows three lifecycle-exit tiles (active is in the headline row). Top-N scope distribution gets a `+ N more scopes (M)` reconciliation row when truncated. The capped `1,000+` open-conflict tile is gone in favour of the exact engine count. The footer's `vec: on/off` indicator is gone (the `~/system` page owns the vector-retrieval probe). Memory + conflict + audit row pills are lowercase in neutral foreground; the `forget` button matches `pin` / `confirm` (no warn tone). Audit row memory-IDs default to white, accent on hover.
  - **System & health.** Six probes ordered along the dependency chain: `node` → `database` → `native binding` → `vector retrieval` → `scrubber` → `version`. Indicator dots use a traffic-light mapping (`synapse` for ok, `warn` for warn, `destructive` for off) that's no longer ambiguous between ok and warn. `schema version` and `last write` removed (former invariant, latter content-state). The standalone `embedder` probe rolled into `vector retrieval` (which absorbs the embedder model + dimension on the note line and flips to `warn` when vector is on but embedder is missing).

  Plus a regression-test pass: 17 new unit tests cover the new `priorEffectiveValue` paths in the config repository, the schema-default-as-oldValue contract in the config command handler, the `IMMUTABLE_CONFIG_KEY_NAMES` drift-prevention invariant, the conflict detector's two dedup branches (re-run on the same memory; reverse-direction pair), and the three `system.info` additions. The total moves from 1,211 → 1,225 passing tests.

## 0.6.0

### Minor Changes

- 1dc5f71: Stress-test fix consolidation pass. Closes every P0/P1/P2 finding from a multi-round adversarial audit of correctness contracts and adoption-scale behaviour, with regression tests for each fix and a re-runnable stress harness checked in. Defaults are conservative — every behaviour change is either restoring a documented contract that wasn't actually firing, tightening input that was previously a silent footgun, or adding an opt-in escape hatch. Functional behaviour on the happy path is unchanged.

  **Conflict detection actually fires now** (`@psraghuveer/memento-core`)

  The preference / decision policies parsed `topic: value` from a regex anchored to end-of-string, so the canonical `topic: value\n\nfree prose ...` shape that AGENTS.md recommends silently coexisted instead of opening a conflict. The parser now reads only the first line, matching the documented contract. Two textbook conflict pairs (pnpm vs yarn preferences with prose; postgres vs mysql decisions with prose) now produce open conflicts via the post-write hook as advertised.

  **Scrubber correctness** (`@psraghuveer/memento-schema`)

  - New default rules: `db-credential`, `stripe-key`, `google-api-key`, `sendgrid-key`, `discord-token`, `basic-auth`, `credit-card`, `ssn`. Each rule has positive and negative regression tests in `packages/core/test/scrubber/defaults.test.ts`.
  - `db-credential` runs _before_ `email` so connection-string credentials (`postgres://user:pass@host/db`) are redacted with a labeled placeholder `<redacted:db-credential>@host` instead of being mislabeled as `<email-redacted>` and eating the host. Internal hostnames without a TLD suffix (`mysql://user:pass@mysql-host/db`) are now caught.
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
