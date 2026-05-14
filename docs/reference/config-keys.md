# Config Keys

> **This file is auto-generated from `@psraghuveer/memento-schema/config-keys` via `pnpm docs:generate`. Do not edit by hand.**

Every behavioural knob in Memento is addressable by a dotted `ConfigKey` and validated by a per-key Zod schema.

The defaults below are the values the runtime starts with when no override is provided by user, workspace, env, CLI, or MCP.

Keys marked **immutable** may not be changed after server start — `config.set` against them returns an `IMMUTABLE` error.

Total: 98 keys.

## `decay.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `decay.halfLife.fact` | `7776000000` | yes | Half-life for `fact` memories, in milliseconds. |
| `decay.halfLife.preference` | `15552000000` | yes | Half-life for `preference` memories, in milliseconds. |
| `decay.halfLife.decision` | `31536000000` | yes | Half-life for `decision` memories, in milliseconds. |
| `decay.halfLife.todo` | `1209600000` | yes | Half-life for `todo` memories, in milliseconds. |
| `decay.halfLife.snippet` | `2592000000` | yes | Half-life for `snippet` memories, in milliseconds. |
| `decay.pinnedFloor` | `0.5` | yes | Lower bound on effective confidence for pinned memories. |
| `decay.archiveThreshold` | `0.05` | yes | Effective confidence below which `compact` archives a memory. |
| `decay.archiveAfter` | `31536000000` | yes | Maximum age before `compact` archives an unconfirmed memory, in milliseconds. |

## `conflict.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `conflict.enabled` | `true` | yes | Master toggle for conflict detection. When false, the post-write hook is a no-op and `conflict.scan` becomes the only source of new conflicts. |
| `conflict.timeoutMs` | `2000` | yes | Per-write detection budget in milliseconds. Hook runs that exceed this are dropped with a timeout warning; recovery is via `conflict.scan`. |
| `conflict.scopeStrategy` | `"same"` | yes | Candidate scope strategy for the post-write hook. `'same'` checks only the new memory's own scope; `'effective'` widens to the layered effective scope set. |
| `conflict.surfaceInSearch` | `true` | yes | Whether `memory.search` annotates results that participate in an open conflict. Off disables the read-side surfacing without affecting detection. |
| `conflict.maxOpenBeforeWarning` | `50` | yes | Open-conflict count above which `memento doctor` raises a triage-backlog warning. |
| `conflict.fact.overlapThreshold` | `3` | yes | Minimum shared-token count before the `fact` policy considers a conflict. |
| `conflict.detector.maxCandidates` | `1000` | yes | Maximum candidate set size considered by `conflict.scan` per memory. |
| `conflict.list.defaultLimit` | `100` | yes | Default page size for `conflict.list` when no limit is supplied. |
| `conflict.list.maxLimit` | `1000` | yes | Hard upper bound on `conflict.list` page size. |

## `embedding.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `embedding.rebuild.defaultBatchSize` | `100` | yes | Default batch size for `embedding.rebuild` when no batchSize is supplied. |
| `embedding.rebuild.maxBatchSize` | `1000` | yes | Hard upper bound on `embedding.rebuild` batch size. |
| `embedding.autoEmbed` | `true` | yes | When true and an EmbeddingProvider is wired, newly-written memories are embedded immediately after write (fire-and-forget). Disable to defer embedding to manual `embedding rebuild` runs. |
| `embedding.startupBackfill.enabled` | `true` | no | When true and an EmbeddingProvider is wired, the server runs a bounded re-embed pass at boot to drain memories whose stored vector is missing or stale. Off-thread (does not block the first request); bounded by `embedding.startupBackfill.maxRows`. Disable to require explicit `embedding rebuild` runs only. |
| `embedding.startupBackfill.maxRows` | `1000` | no | Hard upper bound on the number of memories the startup-backfill pass scans per boot. The pass walks the active corpus newest-first and stops at this cap; remaining stale rows surface on the next boot or via `embedding rebuild`. |

## `compact.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `compact.run.defaultBatchSize` | `1000` | yes | Default batch size for `compact.run` when no batchSize is supplied. |
| `compact.run.maxBatches` | `100` | yes | Safety cap on the number of batches `compact.run` will process in `mode: "drain"`. Drain stops when an iteration archives nothing OR this cap is hit, whichever happens first. Raise it for very large corpora; lower it to bound the operation in shared environments. |

## `memory.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `memory.list.defaultLimit` | `100` | yes | Default page size for `memory.list` when no limit is supplied. |
| `memory.list.maxLimit` | `1000` | yes | Hard upper bound on `memory.list` page size. |

## `events.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `events.list.defaultLimit` | `100` | yes | Default page size for `memory.events` when no limit is supplied. |
| `events.list.maxLimit` | `1000` | yes | Hard upper bound on `memory.events` page size. |

## `storage.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `storage.busyTimeoutMs` | `5000` | no | SQLite `busy_timeout` PRAGMA, in milliseconds. Pinned at server start. |

## `server.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `server.maxMessageBytes` | `4194304` | no | Hard upper bound on a single JSON-RPC message read from stdin, in bytes. Messages exceeding this are rejected and the transport closes the stream. Pinned at server start. |

## `retrieval.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `retrieval.fts.tokenizer` | `"porter"` | no | FTS5 tokenizer for `memories_fts`. `porter` stems tokens (so "colleagues" and "colleague's" share a stem and match each other in search) and is chained onto `unicode61` so non-ASCII content still tokenises correctly. `unicode61` alone is exact-token matching with no stemming — choose this only when proper-noun precision matters more than prose recall. Migration 0008 sets the FTS index up with porter; switching to `unicode61` requires a manual `drop table memories_fts` and reindex, which is why the key is immutable. |
| `retrieval.vector.enabled` | `true` | yes | When true, retrieval unions FTS candidates with cosine-similarity matches over `embedding`. Requires an `EmbeddingProvider` to be wired into the host; `memory.search` returns CONFIG_ERROR when the flag is on and no provider is present. |
| `retrieval.vector.backend` | `"auto"` | no | Vector search backend selector. `brute-force` is the shipping backend; `auto` resolves to it. |
| `retrieval.ranker.strategy` | `"linear"` | yes | Ranker strategy. `linear` (default) is the weighted-sum ranker that the shipped `retrieval.ranker.weights.*` defaults are tuned for: FTS and cosine arms are batch-max-normalised to `[0, 1]` and composed with the four baseline arms (confidence, recency, scope, pinned) which are already `[0, 1]`. `rrf` (Reciprocal Rank Fusion) replaces the FTS and cosine arms with rank-based contributions `weight_a / (k + rank_a)` — values at `k=60` are around `0.016` at rank 1, three orders of magnitude smaller than `linear`. Flipping to `rrf` at the shipped weight defaults will heavily suppress the FTS and vector arms relative to the baselines; rescale `retrieval.ranker.weights.fts` / `retrieval.ranker.weights.vector` by roughly `(k + 1)` when switching. Tune `k` via `retrieval.ranker.rrf.k`. |
| `retrieval.diversity.lambda` | `1` | yes | MMR trade-off between relevance and diversity. `1.0` (default) is a passthrough — preserves the ranker output unchanged. `0.5` balances relevance against diversity. `0.0` is pure diversity, ignoring relevance. Applied as a post-rank reorder over the ranked page; rows without a stored embedding bypass the diversity penalty. |
| `retrieval.diversity.maxDuplicates` | `5` | yes | Soft ceiling on near-duplicate (cosine ≥ 0.9) candidates admitted to a single page before the MMR pass starts skipping. Compose with `retrieval.diversity.lambda`: lambda controls the per-pick reorder weight, maxDuplicates puts a hard cap on the clustering itself. Default `5` is effectively off for most pages; lower to suppress dense clusters. |
| `retrieval.ranker.rrf.k` | `60` | yes | Reciprocal-rank fusion dampening constant. Per-arm contribution is `weight_a / (k + rank_a)`. Higher `k` flattens the contribution curve so lower-ranked candidates retain more weight; lower `k` concentrates weight at the top. Literature default is `60`. Only consulted when `retrieval.ranker.strategy = rrf`. |
| `retrieval.ranker.weights.fts` | `1` | yes | Linear ranker weight on the normalised FTS5 BM25 score. |
| `retrieval.ranker.weights.vector` | `1` | yes | Linear ranker weight on the normalised cosine-similarity score. |
| `retrieval.ranker.weights.confidence` | `0.5` | yes | Linear ranker weight on `effectiveConfidence` (storedConfidence × decayFactor). |
| `retrieval.ranker.weights.recency` | `0.25` | yes | Linear ranker weight on the recency boost. Set to 0 alongside `retrieval.recency.halfLife = 0` to disable. |
| `retrieval.ranker.weights.scope` | `0.25` | yes | Linear ranker weight on the scope-specificity boost (more-specific scopes rank higher when the query spans a layered set). |
| `retrieval.ranker.weights.pinned` | `0.25` | yes | Linear ranker weight added when a memory is pinned. |
| `retrieval.ranker.weights.supersedingMultiplier` | `0.5` | yes | Multiplier applied to a superseded memory's final score when its successor (the memory pointed to by `supersededBy`) is co-present in the same result set. `1.0` disables demotion; `0.0` collapses superseded predecessors to zero score. Default `0.5` keeps the chain visible while ranking the active head higher. Only fires when callers opt into superseded retrieval via `memory.search`'s `includeStatuses: ["active", "superseded"]`; default search behaviour (active-only) is unaffected. |
| `retrieval.recency.halfLife` | `2592000000` | yes | Half-life of the recency boost, in milliseconds. The boost decays as 0.5 ^ ((now − lastConfirmedAt) / halfLife). Set to 0 to disable the boost regardless of weight. |
| `retrieval.scopeBoost` | `0.1` | yes | Per-level boost applied to scope-specificity. The most-specific scope in the resolved layer set scores N × scopeBoost; the least-specific scores 0. |
| `retrieval.search.defaultLimit` | `20` | yes | Default result count for `memory.search` when no limit is supplied. |
| `retrieval.search.maxLimit` | `200` | yes | Hard upper bound on `memory.search` result count. |
| `retrieval.candidate.ftsLimit` | `500` | yes | Maximum FTS5 candidates fetched per query before ranking. Keeps the ranker fast at the cost of recall on very-frequent terms. Common-word queries (`the`, `is`, `and`, etc.) match many memories at low BM25 — the cap keeps p95 latency flat. Lower it (e.g. 200) for faster common-word queries; raise it (e.g. 1000+) for richer recall on broad searches at the cost of more ranker work per call. |
| `retrieval.candidate.vectorLimit` | `200` | yes | Maximum vector candidates fetched per query before ranking. Only consulted when `retrieval.vector.enabled` is true. |
| `retrieval.candidate.ftsMinScore` | `0` | yes | Minimum absolute BM25 score below which an FTS-only candidate is dropped from the union before ranking. SQLite FTS5 reports BM25 as a negative number where more-negative = more-relevant; this threshold compares against `\|bm25\|`. Candidates that also match the vector arm above its floor survive regardless. Default `0` preserves prior behaviour (no filtering). |
| `retrieval.candidate.vectorMinCosine` | `-1` | yes | Minimum cosine similarity below which a vector-only candidate is dropped from the union before ranking. Cosine is bounded in `[-1, 1]`; raise to ~0.85 to suppress the paraphrase-noise floor that pollutes top-K on neutral queries. Candidates that also match the FTS arm above its floor survive regardless. Default `-1` preserves prior behaviour (no filtering). |

## `embedder.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `embedder.local.model` | `"bge-base-en-v1.5"` | no | Hugging Face model id for `@psraghuveer/memento-embedder-local`. Resolved as `Xenova/<model>` on the Hub. Pinned at server start; changing it requires `embedding rebuild`. |
| `embedder.local.dimension` | `768` | no | Expected vector dimension for the configured embedder model. Must match `embedder.local.model`; the embedder rejects vectors of any other length. Pinned at server start. |
| `embedder.local.maxInputBytes` | `32768` | no | Maximum byte length of text passed to the local embedder. Inputs above this are truncated to the cap before tokenisation. Pinned at server start because crossing the cap would change retrieval semantics. |
| `embedder.local.timeoutMs` | `10000` | no | Wallclock timeout for a single embed call, in milliseconds. The embedder rejects with a typed error after this elapses; auto-embed swallows it (the memory is written without a vector and `embedding rebuild` recovers). |
| `embedder.local.cacheDir` | `null` | no | Directory in which the local embedder caches downloaded model files. `null` resolves to `<XDG_CACHE_HOME>/memento/models` (or the platform equivalent) at startup; otherwise the literal path is used. Pinned at server start. |
| `embedder.local.warmupOnBoot` | `true` | no | When true and an EmbeddingProvider that exposes `warmup()` is wired, the server fires a fire-and-forget warmup at boot so the first user-facing query does not pay the lazy-init cost (model dynamic-import + pipeline construction). Disable to keep the embedder strictly demand-loaded. |

## `scrubber.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `scrubber.enabled` | `true` | no | Master toggle for the write-path scrubber. When false, writes pass through unredacted and no `scrubReport` is recorded. Pinned at server start. |
| `scrubber.rules` | `[{"id":"openai-api-key","description":"OpenAI-style API key (sk-...)","pattern"…` | no | Active scrubber rule set. Order is significant — first match wins. Defaults to the rules shipped in `DEFAULT_SCRUBBER_RULES`. Pinned at server start. |
| `scrubber.engineBudgetMs` | `50` | yes | Per-rule wallclock budget for the scrubber engine, in milliseconds. A rule that exceeds the budget is aborted and treated as "no match" for that rule on this write. |

## `privacy.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `privacy.redactSensitiveSnippets` | `true` | yes | When true, `memory.list` and `memory.search` project sensitive memories to a redacted view (`content: null`, `redacted: true`). `memory.read` always returns full text. |

## `write.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `write.defaultConfidence` | `1` | yes | Default `storedConfidence` for new memories when the caller omits the field. 1.0 means full confidence at write time; decay handles degradation over time. |
| `write.defaultPinned` | `false` | yes | Default `pinned` value for new memories when the caller omits the field. Pinned memories are exempt from confidence decay. |

## `safety.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `safety.batchWriteLimit` | `100` | yes | Maximum number of items accepted by a single `memory.write_many` call. Requests exceeding this limit are rejected with `INVALID_INPUT` before any write runs. |
| `safety.bulkDestructiveLimit` | `1000` | yes | Maximum number of memories a single bulk-destructive call (`memory.forget_many`, `memory.archive_many`) may transition. Applied when `dryRun: false`; rehearsals are uncapped. Requests exceeding the cap are rejected with `INVALID_INPUT` before any row is touched. |
| `safety.memoryContentMaxBytes` | `65536` | yes | Maximum byte length of `memory.write` (and supersede / extract) content. Inputs exceeding this are rejected with `INVALID_INPUT` before the scrubber or storage layer runs. |
| `safety.summaryMaxBytes` | `2048` | yes | Maximum byte length of `memory.write` summary. Summaries are one-line listings; the cap reflects that intent. |
| `safety.tagMaxCount` | `64` | yes | Maximum number of tags accepted on a single `memory.write`. Each tag is independently capped at 64 characters by `TagSchema`. |
| `safety.requireTopicLine` | `true` | yes | When `true` (default), reject `memory.write`, `memory.write_many`, `memory.supersede`, and `memory.extract` calls whose `kind` is `preference` or `decision` and whose content's first non-blank line does not match the `topic: value` (or `topic = value`) convention. The rule mirrors the conflict detector's preference/decision parser — content that bypasses detection at retrieval time is rejected at write time. Flip to `false` to keep the historical permissive shape (at the cost of silent conflict-detection misses). |

## `extraction.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `extraction.enabled` | `true` | yes | Master switch for `memory.extract`. When false, the command returns a structured error. |
| `extraction.dedup.threshold` | `0.85` | yes | Cosine similarity floor for dedup consideration during extraction. Candidates below this are written as new. |
| `extraction.dedup.identicalThreshold` | `0.95` | yes | Cosine similarity above which a candidate is treated as a duplicate and skipped (same kind required). |
| `extraction.defaultConfidence` | `0.8` | yes | Default `storedConfidence` for memories written via `memory.extract`. Lower than manual writes so extracted memories decay faster. |
| `extraction.autoTag` | `"source:extracted"` | yes | Tag automatically added to memories written via `memory.extract`. Empty string to disable. |
| `extraction.maxCandidatesPerCall` | `20` | yes | Maximum number of candidates accepted by a single `memory.extract` call. |
| `extraction.processing` | `"async"` | yes | Processing mode for `memory.extract`. `async` (default) returns a receipt immediately and processes in background; `sync` blocks until all candidates are processed and returns the full results. |

## `context.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `context.defaultLimit` | `20` | yes | Default number of memories returned by `memory.context` when no limit is supplied. |
| `context.maxLimit` | `100` | yes | Hard upper bound on `memory.context` result count. |
| `context.candidateLimit` | `500` | yes | Maximum candidate memories the `memory.context` ranker considers per call before applying the weighted score. Pinned memories are always added regardless of this cap. Lower values keep p50 latency flat as the corpus grows; raise it to broaden the candidate pool at the cost of more ranker work. |
| `context.includeKinds` | `["fact","preference","decision"]` | yes | Which memory kinds `memory.context` includes by default. Todos and snippets are often transient. |
| `context.ranker.weights.confidence` | `1` | yes | Context ranker weight on effective confidence. |
| `context.ranker.weights.recency` | `1.5` | yes | Context ranker weight on recency (higher than search — context favours fresh). |
| `context.ranker.weights.scope` | `2` | yes | Context ranker weight on scope match (strong: prefer local context). |
| `context.ranker.weights.pinned` | `3` | yes | Context ranker weight for pinned memories (always surface). |
| `context.ranker.weights.frequency` | `0.5` | yes | Context ranker weight for confirmation frequency (memories confirmed often rank higher). |
| `context.hint.uniformSpreadThreshold` | `0.05` | yes | When `memory.context` returns a page whose top-bottom score spread is below this value AND the page has at least two results, the response carries a hint suggesting the caller pass a `scopes` filter or call `memory.search` with a topic for a sharper signal. Set to `0` to disable. |
| `context.diversity.lambda` | `0.7` | yes | MMR trade-off for `memory.context` between relevance and diversity. `1.0` is a passthrough — preserves the ranker output unchanged. `0.7` (default) gently breaks near-duplicate clusters so the session-start survey covers more topics. `0.0` is pure diversity. Memories without a stored embedding bypass the diversity penalty. |
| `context.diversity.maxDuplicates` | `5` | yes | Soft ceiling on near-duplicate (cosine ≥ 0.9) candidates admitted to a `memory.context` page before the MMR pass starts skipping. Mirrors `retrieval.diversity.maxDuplicates` for the context surface. |

## `export.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `export.includeEmbeddings` | `false` | yes | Default for `memento export` when `--include-embeddings` is not passed. Embeddings are model-bound and rebuildable, so the default is `false`; flip to `true` only if you know the destination machine cannot rebuild them. |
| `export.defaultPath` | `null` | yes | Default destination path for `memento export` when `--out` is not passed. `null` means write to stdout; a string is treated as a filesystem path. |

## `import.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `import.maxBytes` | `268435456` | yes | Maximum byte length of an artefact accepted by `memento import`. Files exceeding this are rejected before any read begins. Default is 256 MiB. |

## `packs.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `packs.bundledRegistryPath` | `null` | no | Filesystem path to the directory containing bundled official packs. `null` defers to the runtime default (the bundled `packs/` directory shipped with the package). Pinned at server start so it cannot be flipped at runtime to point at attacker-controlled paths. |
| `packs.allowRemoteUrls` | `true` | yes | Master switch for `pack install --from-url`. Operators in restricted environments flip to `false` to disable HTTPS-fetch packs entirely. |
| `packs.urlFetchTimeoutMs` | `10000` | yes | Per-request timeout for `pack install --from-url`, in milliseconds. Fetches that exceed this are aborted. |
| `packs.maxPackSizeBytes` | `1048576` | yes | Maximum byte length of a pack manifest accepted by `pack install`. Applies to local files and URL fetches alike. Default is 1 MiB. |
| `packs.maxMemoriesPerPack` | `200` | yes | Per-pack ceiling on the number of memories in a manifest. Manifests over this cap are rejected with `INVALID_INPUT`. |

## `user.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `user.preferredName` | `null` | yes | How an assistant should refer to the user when writing memory content. Surfaced in `system.info` so the assistant can attribute statements (e.g. "Raghu prefers pnpm" rather than "User prefers pnpm"). When `null`, the assistant should write "The user" instead. Set with `memento config set user.preferredName "<name>"`. |
