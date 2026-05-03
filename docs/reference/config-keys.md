# Config Keys

> **This file is auto-generated from `@psraghuveer/memento-schema/config-keys` via `pnpm docs:generate`. Do not edit by hand.**

Every behavioural knob in Memento is addressable by a dotted `ConfigKey` and validated by a per-key Zod schema.

The defaults below are the values the runtime starts with when no override is provided by user, workspace, env, CLI, or MCP.

Keys marked **immutable** may not be changed after server start — `config.set` against them returns an `IMMUTABLE` error.

Total: 69 keys.

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
| `conflict.timeoutMs` | `2000` | yes | Per-write detection budget in milliseconds. Hook runs that exceed this are dropped with a `conflict.timeout` warning; recovery is via `conflict.scan`. |
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

## `compact.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `compact.run.defaultBatchSize` | `1000` | yes | Default batch size for `compact.run` when no batchSize is supplied. |

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

## `retrieval.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `retrieval.fts.tokenizer` | `"unicode61"` | no | FTS5 tokenizer for `memories_fts`. Pinned at server start because changing it requires a reindex. |
| `retrieval.vector.enabled` | `true` | yes | When true, retrieval unions FTS candidates with cosine-similarity matches over `embedding`. Requires an `EmbeddingProvider` to be wired into the host; `memory.search` returns CONFIG_ERROR when the flag is on and no provider is present. |
| `retrieval.vector.backend` | `"auto"` | no | Vector search backend selector. `brute-force` is the shipping backend; `auto` resolves to it. |
| `retrieval.ranker.strategy` | `"linear"` | yes | Ranker strategy. `linear` is the shipping strategy; the enum can be widened without breaking existing configs. |
| `retrieval.ranker.weights.fts` | `1` | yes | Linear ranker weight on the normalised FTS5 BM25 score. |
| `retrieval.ranker.weights.vector` | `1` | yes | Linear ranker weight on the normalised cosine-similarity score. |
| `retrieval.ranker.weights.confidence` | `0.5` | yes | Linear ranker weight on `effectiveConfidence` (storedConfidence × decayFactor). |
| `retrieval.ranker.weights.recency` | `0.25` | yes | Linear ranker weight on the recency boost. Set to 0 alongside `retrieval.recency.halfLife = 0` to disable. |
| `retrieval.ranker.weights.scope` | `0.25` | yes | Linear ranker weight on the scope-specificity boost (more-specific scopes rank higher when the query spans a layered set). |
| `retrieval.ranker.weights.pinned` | `0.25` | yes | Linear ranker weight added when a memory is pinned. |
| `retrieval.recency.halfLife` | `2592000000` | yes | Half-life of the recency boost, in milliseconds. The boost decays as 0.5 ^ ((now − lastConfirmedAt) / halfLife). Set to 0 to disable the boost regardless of weight. |
| `retrieval.scopeBoost` | `0.1` | yes | Per-level boost applied to scope-specificity. The most-specific scope in the resolved layer set scores N × scopeBoost; the least-specific scores 0. |
| `retrieval.search.defaultLimit` | `20` | yes | Default result count for `memory.search` when no limit is supplied. |
| `retrieval.search.maxLimit` | `200` | yes | Hard upper bound on `memory.search` result count. |
| `retrieval.candidate.ftsLimit` | `500` | yes | Maximum FTS5 candidates fetched per query before ranking. Keeps the ranker fast at the cost of recall on very-frequent terms. |
| `retrieval.candidate.vectorLimit` | `200` | yes | Maximum vector candidates fetched per query before ranking. Only consulted when `retrieval.vector.enabled` is true. |

## `embedder.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `embedder.local.model` | `"bge-base-en-v1.5"` | no | Hugging Face model id for `@psraghuveer/memento-embedder-local`. Resolved as `Xenova/<model>` on the Hub. Pinned at server start; changing it requires `embedding rebuild`. |
| `embedder.local.dimension` | `768` | no | Expected vector dimension for the configured embedder model. Must match `embedder.local.model`; the embedder rejects vectors of any other length. Pinned at server start. |

## `scrubber.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `scrubber.enabled` | `true` | yes | Master toggle for the write-path scrubber. When false, writes pass through unredacted and no `scrubReport` is recorded. |
| `scrubber.rules` | `[{"id":"openai-api-key","description":"OpenAI-style API key (sk-...)","pattern"…` | yes | Active scrubber rule set. Order is significant — first match wins. Defaults to the rules shipped in `DEFAULT_SCRUBBER_RULES`. |

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
| `context.includeKinds` | `["fact","preference","decision"]` | yes | Which memory kinds `memory.context` includes by default. Todos and snippets are often transient. |
| `context.ranker.weights.confidence` | `1` | yes | Context ranker weight on effective confidence. |
| `context.ranker.weights.recency` | `1.5` | yes | Context ranker weight on recency (higher than search — context favours fresh). |
| `context.ranker.weights.scope` | `2` | yes | Context ranker weight on scope match (strong: prefer local context). |
| `context.ranker.weights.pinned` | `3` | yes | Context ranker weight for pinned memories (always surface). |
| `context.ranker.weights.frequency` | `0.5` | yes | Context ranker weight for confirmation frequency (memories confirmed often rank higher). |

## `export.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `export.includeEmbeddings` | `false` | yes | Default for `memento export` when `--include-embeddings` is not passed. Embeddings are model-bound and rebuildable, so the default is `false`; flip to `true` only if you know the destination machine cannot rebuild them. |
| `export.defaultPath` | `null` | yes | Default destination path for `memento export` when `--out` is not passed. `null` means write to stdout; a string is treated as a filesystem path. |

## `user.*`

| Key | Default | Mutable | Description |
| --- | --- | --- | --- |
| `user.preferredName` | `null` | yes | How an assistant should refer to the user when writing memory content. Surfaced in `system.info` so the assistant can attribute statements (e.g. "Raghu prefers pnpm" rather than "User prefers pnpm"). When `null`, the assistant should write "The user" instead. Set with `memento config set user.preferredName "<name>"`. |
