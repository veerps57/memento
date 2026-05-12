// Config key registry.
//
// `docs/architecture/config.md` mandates that every behavioral
// knob in Memento is addressable by a dotted `ConfigKey` and
// validated against a per-key Zod schema. This module is that
// registry — the single source of truth for what keys exist,
// what shapes their values take, and what the built-in default
// resolves to.
//
// The registry is the foundation for `ConfigStore` (in
// `@psraghuveer/memento-core`), which layers user/workspace/env/cli/mcp
// sources on top of these defaults. v1 of the store reads only
// in-process overrides (test ergonomics + initial wiring); the
// full layering pipeline lands when MCP+CLI runtime
// configuration ships.
//
// The registry is intentionally additive: adding a new key
// requires touching this file (so the change is visible in the
// PR diff and in the generated `docs/reference/config-keys.md`).
// Renaming or removing a key is a breaking change.
//
// Per-key invariants:
//
//   - The `default` value must satisfy `schema`. We enforce this
//     structurally via the generic `defineKey` helper: TypeScript
//     reports a mismatch at the call site rather than at runtime.
//   - `mutable: false` marks keys that may not be changed after
//     server start (e.g. storage paths, busy timeouts). Runtime
//     `config.set` against such a key is rejected.
//   - `description` is the prose surfaced in the generated
//     reference doc. Keep it tight; one sentence is best.

import { z } from 'zod';
import { DEFAULT_SCRUBBER_RULES, ScrubberRuleSetSchema } from './scrubber.js';

const MS_PER_DAY = 86_400_000;

/**
 * Per-key registry entry. Generic over the value type `T` so
 * `default` is statically constrained to the type the `schema`
 * accepts. Use {@link defineKey} to construct entries — the
 * helper anchors the inference site so each entry's `T` is
 * captured rather than widened.
 */
export interface ConfigKeyDefinition<T> {
  readonly schema: z.ZodType<T>;
  readonly default: T;
  readonly mutable: boolean;
  readonly description: string;
}

/**
 * Identity helper that pins `T` at the call site. Use over a
 * bare object literal so TypeScript catches `default`-vs-`schema`
 * mismatches before the registry is ever consulted at runtime.
 */
const defineKey = <T>(def: ConfigKeyDefinition<T>): ConfigKeyDefinition<T> => Object.freeze(def);

// Reusable per-shape schemas. Kept in this file so the registry
// is self-contained and the doc generator can introspect them
// without crossing module boundaries.
const PositiveFinite = z.number().positive().finite();
const PositiveInt = z.number().int().positive();
const Probability = z.number().min(0).max(1);

/**
 * The complete set of `ConfigKey`s. Adding a key here:
 *
 *   1. Pick a dotted name aligned with `docs/architecture/config.md`.
 *   2. Define the schema (reuse one of the shape constants when
 *      possible; otherwise build a new Zod schema).
 *   3. Pick a default that produces sensible behavior on first use.
 *   4. Decide `mutable`. The default is `true`; reach for `false`
 *      only when changing the value mid-session would corrupt
 *      state or break invariants.
 *   5. Write a one-sentence description.
 *
 * Keys are grouped by namespace; group order matches the order
 * in `docs/architecture/config.md`.
 */
export const CONFIG_KEYS = {
  // — Decay —
  'decay.halfLife.fact': defineKey({
    schema: PositiveFinite,
    default: 90 * MS_PER_DAY,
    mutable: true,
    description: 'Half-life for `fact` memories, in milliseconds.',
  }),
  'decay.halfLife.preference': defineKey({
    schema: PositiveFinite,
    default: 180 * MS_PER_DAY,
    mutable: true,
    description: 'Half-life for `preference` memories, in milliseconds.',
  }),
  'decay.halfLife.decision': defineKey({
    schema: PositiveFinite,
    default: 365 * MS_PER_DAY,
    mutable: true,
    description: 'Half-life for `decision` memories, in milliseconds.',
  }),
  'decay.halfLife.todo': defineKey({
    schema: PositiveFinite,
    default: 14 * MS_PER_DAY,
    mutable: true,
    description: 'Half-life for `todo` memories, in milliseconds.',
  }),
  'decay.halfLife.snippet': defineKey({
    schema: PositiveFinite,
    default: 30 * MS_PER_DAY,
    mutable: true,
    description: 'Half-life for `snippet` memories, in milliseconds.',
  }),
  'decay.pinnedFloor': defineKey({
    schema: Probability,
    default: 0.5,
    mutable: true,
    description: 'Lower bound on effective confidence for pinned memories.',
  }),
  'decay.archiveThreshold': defineKey({
    schema: Probability,
    default: 0.05,
    mutable: true,
    description: 'Effective confidence below which `compact` archives a memory.',
  }),
  'decay.archiveAfter': defineKey({
    schema: PositiveFinite,
    default: 365 * MS_PER_DAY,
    mutable: true,
    description: 'Maximum age before `compact` archives an unconfirmed memory, in milliseconds.',
  }),

  // — Conflict —
  // Runtime knobs for the post-write hook + read-side surfacing
  // per ADR-0005 and `docs/architecture/conflict-detection.md`.
  // Detection itself is implemented; these keys gate _when_ and
  // _how_ it runs from the write path and is exposed to readers.
  'conflict.enabled': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'Master toggle for conflict detection. When false, the post-write hook is a no-op and `conflict.scan` becomes the only source of new conflicts.',
  }),
  'conflict.timeoutMs': defineKey({
    schema: PositiveInt,
    default: 2_000,
    mutable: true,
    description:
      'Per-write detection budget in milliseconds. Hook runs that exceed this are dropped with a timeout warning; recovery is via `conflict.scan`.',
  }),
  'conflict.scopeStrategy': defineKey({
    schema: z.enum(['same', 'effective']),
    default: 'same',
    mutable: true,
    description:
      "Candidate scope strategy for the post-write hook. `'same'` checks only the new memory's own scope; `'effective'` widens to the layered effective scope set.",
  }),
  'conflict.surfaceInSearch': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'Whether `memory.search` annotates results that participate in an open conflict. Off disables the read-side surfacing without affecting detection.',
  }),
  'conflict.maxOpenBeforeWarning': defineKey({
    schema: PositiveInt,
    default: 50,
    mutable: true,
    description:
      'Open-conflict count above which `memento doctor` raises a triage-backlog warning.',
  }),
  'conflict.fact.overlapThreshold': defineKey({
    schema: PositiveInt,
    default: 3,
    mutable: true,
    description: 'Minimum shared-token count before the `fact` policy considers a conflict.',
  }),
  'conflict.detector.maxCandidates': defineKey({
    schema: PositiveInt,
    default: 1_000,
    mutable: true,
    description: 'Maximum candidate set size considered by `conflict.scan` per memory.',
  }),
  'conflict.list.defaultLimit': defineKey({
    schema: PositiveInt,
    default: 100,
    mutable: true,
    description: 'Default page size for `conflict.list` when no limit is supplied.',
  }),
  'conflict.list.maxLimit': defineKey({
    schema: PositiveInt,
    default: 1_000,
    mutable: true,
    description: 'Hard upper bound on `conflict.list` page size.',
  }),

  // — Embedding —
  'embedding.rebuild.defaultBatchSize': defineKey({
    schema: PositiveInt,
    default: 100,
    mutable: true,
    description: 'Default batch size for `embedding.rebuild` when no batchSize is supplied.',
  }),
  'embedding.rebuild.maxBatchSize': defineKey({
    schema: PositiveInt,
    default: 1_000,
    mutable: true,
    description: 'Hard upper bound on `embedding.rebuild` batch size.',
  }),

  // — Compact —
  'compact.run.defaultBatchSize': defineKey({
    schema: PositiveInt,
    default: 1_000,
    mutable: true,
    description: 'Default batch size for `compact.run` when no batchSize is supplied.',
  }),

  // — Memory list —
  'memory.list.defaultLimit': defineKey({
    schema: PositiveInt,
    default: 100,
    mutable: true,
    description: 'Default page size for `memory.list` when no limit is supplied.',
  }),
  'memory.list.maxLimit': defineKey({
    schema: PositiveInt,
    default: 1_000,
    mutable: true,
    description: 'Hard upper bound on `memory.list` page size.',
  }),

  // — Events list —
  'events.list.defaultLimit': defineKey({
    schema: PositiveInt,
    default: 100,
    mutable: true,
    description: 'Default page size for `memory.events` when no limit is supplied.',
  }),
  'events.list.maxLimit': defineKey({
    schema: PositiveInt,
    default: 1_000,
    mutable: true,
    description: 'Hard upper bound on `memory.events` page size.',
  }),

  // — Storage —
  'storage.busyTimeoutMs': defineKey({
    schema: PositiveInt,
    default: 5_000,
    mutable: false,
    description: 'SQLite `busy_timeout` PRAGMA, in milliseconds. Pinned at server start.',
  }),

  // — Server —
  // Hard ceiling on the size of a single JSON-RPC message read
  // from stdin. Without this, a peer that withholds a trailing
  // newline can grow the read buffer until Node OOMs. Pinned
  // at server start because the cap is enforced inside the
  // stdio transport wrapper that wraps `process.stdin`.
  'server.maxMessageBytes': defineKey({
    schema: z
      .number()
      .int()
      .min(64 * 1024)
      .max(64 * 1024 * 1024),
    default: 4 * 1024 * 1024,
    mutable: false,
    description:
      'Hard upper bound on a single JSON-RPC message read from stdin, in bytes. Messages exceeding this are rejected and the transport closes the stream. Pinned at server start.',
  }),

  // — Retrieval —
  // Pipeline shape per `docs/architecture/retrieval.md`. FTS5 is
  // always available; vector search is on by default
  // (`retrieval.vector.enabled` defaults to `true`) and the local
  // embedder ships as a regular dependency of the CLI, so a fresh
  // install gets paraphrase matching with no extra steps. The
  // ranker is a configurable linear combination — every weight is
  // a key here so operators can tune recall vs. precision without
  // code changes (principle 1: configurable defaults).
  'retrieval.fts.tokenizer': defineKey({
    schema: z.enum(['unicode61', 'porter']),
    default: 'unicode61',
    mutable: false,
    description:
      'FTS5 tokenizer for `memories_fts`. Pinned at server start because changing it requires a reindex.',
  }),
  // BM25 `k1` / `b` are intentionally NOT registered. SQLite
  // FTS5 ships with the default values baked in and exposes no
  // tuning surface; registering keys for a knob that does not
  // exist would lie about behaviour. They will be added in the
  // same change that introduces a custom `retrieval.ranker.strategy`
  // capable of honouring them.
  'retrieval.vector.enabled': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'When true, retrieval unions FTS candidates with cosine-similarity matches over `embedding`. Requires an `EmbeddingProvider` to be wired into the host; `memory.search` returns CONFIG_ERROR when the flag is on and no provider is present.',
  }),
  'retrieval.vector.backend': defineKey({
    // The shipping backend is `brute-force`; `auto` resolves
    // to it. A native `sqlite-vec` backend can be added later
    // and will widen this enum without breaking existing configs.
    schema: z.enum(['auto', 'brute-force']),
    default: 'auto',
    mutable: false,
    description:
      'Vector search backend selector. `brute-force` is the shipping backend; `auto` resolves to it.',
  }),
  'retrieval.ranker.strategy': defineKey({
    schema: z.enum(['linear', 'rrf']),
    default: 'linear',
    mutable: true,
    description:
      'Ranker strategy. `linear` (default) is the weighted-sum ranker that the shipped `retrieval.ranker.weights.*` defaults are tuned for: FTS and cosine arms are batch-max-normalised to `[0, 1]` and composed with the four baseline arms (confidence, recency, scope, pinned) which are already `[0, 1]`. `rrf` (Reciprocal Rank Fusion) replaces the FTS and cosine arms with rank-based contributions `weight_a / (k + rank_a)` — values at `k=60` are around `0.016` at rank 1, three orders of magnitude smaller than `linear`. Flipping to `rrf` at the shipped weight defaults will heavily suppress the FTS and vector arms relative to the baselines; rescale `retrieval.ranker.weights.fts` / `retrieval.ranker.weights.vector` by roughly `(k + 1)` when switching. Tune `k` via `retrieval.ranker.rrf.k`.',
  }),
  // Post-rank diversity pass via Maximal Marginal Relevance.
  // Re-orders the top-K so successive picks penalise candidates
  // similar to already-picked rows. `lambda = 1` is a passthrough
  // (default — preserves prior ranking on upgrade); `lambda = 0`
  // is pure diversity, ignoring relevance. The pass needs the
  // candidate embeddings already loaded by the vector arm; rows
  // without an embedding bypass the diversity penalty and ride
  // the relevance score alone.
  'retrieval.diversity.lambda': defineKey({
    schema: Probability,
    default: 1,
    mutable: true,
    description:
      'MMR trade-off between relevance and diversity. `1.0` (default) is a passthrough — preserves the ranker output unchanged. `0.5` balances relevance against diversity. `0.0` is pure diversity, ignoring relevance. Applied as a post-rank reorder over the ranked page; rows without a stored embedding bypass the diversity penalty.',
  }),
  'retrieval.diversity.maxDuplicates': defineKey({
    schema: PositiveInt,
    default: 5,
    mutable: true,
    description:
      'Soft ceiling on near-duplicate (cosine ≥ 0.9) candidates admitted to a single page before the MMR pass starts skipping. Compose with `retrieval.diversity.lambda`: lambda controls the per-pick reorder weight, maxDuplicates puts a hard cap on the clustering itself. Default `5` is effectively off for most pages; lower to suppress dense clusters.',
  }),
  'retrieval.ranker.rrf.k': defineKey({
    // RRF dampening constant. Higher values flatten the
    // contribution curve (more weight on lower-ranked
    // candidates); lower values concentrate weight at the top.
    // 60 is the literature convention (Cormack et al. 2009 and
    // every subsequent re-implementation).
    schema: z.number().int().positive(),
    default: 60,
    mutable: true,
    description:
      'Reciprocal-rank fusion dampening constant. Per-arm contribution is `weight_a / (k + rank_a)`. Higher `k` flattens the contribution curve so lower-ranked candidates retain more weight; lower `k` concentrates weight at the top. Literature default is `60`. Only consulted when `retrieval.ranker.strategy = rrf`.',
  }),
  'retrieval.ranker.weights.fts': defineKey({
    schema: z.number().min(0).finite(),
    default: 1,
    mutable: true,
    description: 'Linear ranker weight on the normalised FTS5 BM25 score.',
  }),
  'retrieval.ranker.weights.vector': defineKey({
    schema: z.number().min(0).finite(),
    default: 1,
    mutable: true,
    description: 'Linear ranker weight on the normalised cosine-similarity score.',
  }),
  'retrieval.ranker.weights.confidence': defineKey({
    schema: z.number().min(0).finite(),
    default: 0.5,
    mutable: true,
    description: 'Linear ranker weight on `effectiveConfidence` (storedConfidence × decayFactor).',
  }),
  'retrieval.ranker.weights.recency': defineKey({
    schema: z.number().min(0).finite(),
    default: 0.25,
    mutable: true,
    description:
      'Linear ranker weight on the recency boost. Set to 0 alongside `retrieval.recency.halfLife = 0` to disable.',
  }),
  'retrieval.ranker.weights.scope': defineKey({
    schema: z.number().min(0).finite(),
    default: 0.25,
    mutable: true,
    description:
      'Linear ranker weight on the scope-specificity boost (more-specific scopes rank higher when the query spans a layered set).',
  }),
  'retrieval.ranker.weights.pinned': defineKey({
    schema: z.number().min(0).finite(),
    default: 0.25,
    mutable: true,
    description: 'Linear ranker weight added when a memory is pinned.',
  }),
  'retrieval.ranker.weights.supersedingMultiplier': defineKey({
    schema: Probability,
    default: 0.5,
    mutable: true,
    description:
      'Multiplier applied to a superseded memory\'s final score when its successor (the memory pointed to by `supersededBy`) is co-present in the same result set. `1.0` disables demotion; `0.0` collapses superseded predecessors to zero score. Default `0.5` keeps the chain visible while ranking the active head higher. Only fires when callers opt into superseded retrieval via `memory.search`\'s `includeStatuses: ["active", "superseded"]`; default search behaviour (active-only) is unaffected.',
  }),
  'retrieval.recency.halfLife': defineKey({
    schema: z.number().min(0).finite(),
    default: 30 * MS_PER_DAY,
    mutable: true,
    description:
      'Half-life of the recency boost, in milliseconds. The boost decays as 0.5 ^ ((now − lastConfirmedAt) / halfLife). Set to 0 to disable the boost regardless of weight.',
  }),
  'retrieval.scopeBoost': defineKey({
    schema: z.number().min(0).finite(),
    default: 0.1,
    mutable: true,
    description:
      'Per-level boost applied to scope-specificity. The most-specific scope in the resolved layer set scores N × scopeBoost; the least-specific scores 0.',
  }),
  'retrieval.search.defaultLimit': defineKey({
    schema: PositiveInt,
    default: 20,
    mutable: true,
    description: 'Default result count for `memory.search` when no limit is supplied.',
  }),
  'retrieval.search.maxLimit': defineKey({
    schema: PositiveInt,
    default: 200,
    mutable: true,
    description: 'Hard upper bound on `memory.search` result count.',
  }),
  'retrieval.candidate.ftsLimit': defineKey({
    schema: PositiveInt,
    default: 500,
    mutable: true,
    description:
      'Maximum FTS5 candidates fetched per query before ranking. Keeps the ranker fast at the cost of recall on very-frequent terms. Common-word queries (`the`, `is`, `and`, etc.) match many memories at low BM25 — the cap keeps p95 latency flat. Lower it (e.g. 200) for faster common-word queries; raise it (e.g. 1000+) for richer recall on broad searches at the cost of more ranker work per call.',
  }),
  'retrieval.candidate.vectorLimit': defineKey({
    // Cosine candidates arrive pre-ordered by similarity, so a
    // smaller cap is enough to cover the long tail of relevant
    // matches the FTS bag missed. Larger caps cost a linear
    // scan over the embeddings table per query (brute-force
    // backend) without changing the top of the ranked page.
    schema: PositiveInt,
    default: 200,
    mutable: true,
    description:
      'Maximum vector candidates fetched per query before ranking. Only consulted when `retrieval.vector.enabled` is true.',
  }),
  // Per-arm minimum-score floors. The candidate union is built
  // by `retrieval.candidate.ftsLimit` and
  // `retrieval.candidate.vectorLimit` regardless of how strong
  // each individual hit is. These two keys add a second gate:
  // candidates whose every arm is below its configured floor
  // are dropped before ranking. A candidate that matches BOTH
  // arms survives if either is above its floor — the cut fires
  // only when every signal the candidate contributed is weak.
  //
  // Defaults are no-ops:
  //   - `ftsMinScore = 0` keeps every FTS hit (|bm25| is always
  //     non-negative).
  //   - `vectorMinCosine = -1` keeps every vector hit (cosine
  //     is bounded in [-1, 1]).
  //
  // Operators raise these to suppress weak-arm candidates that
  // pollute the top-K — typical paraphrase queries score every
  // unrelated row at cosine 0.7-0.85, so a `vectorMinCosine`
  // around 0.85 trims that tail without affecting strong hits.
  'retrieval.candidate.ftsMinScore': defineKey({
    schema: z.number().min(0).finite(),
    default: 0,
    mutable: true,
    description:
      'Minimum absolute BM25 score below which an FTS-only candidate is dropped from the union before ranking. SQLite FTS5 reports BM25 as a negative number where more-negative = more-relevant; this threshold compares against `|bm25|`. Candidates that also match the vector arm above its floor survive regardless. Default `0` preserves prior behaviour (no filtering).',
  }),
  'retrieval.candidate.vectorMinCosine': defineKey({
    schema: z.number().min(-1).max(1),
    default: -1,
    mutable: true,
    description:
      'Minimum cosine similarity below which a vector-only candidate is dropped from the union before ranking. Cosine is bounded in `[-1, 1]`; raise to ~0.85 to suppress the paraphrase-noise floor that pollutes top-K on neutral queries. Candidates that also match the FTS arm above its floor survive regardless. Default `-1` preserves prior behaviour (no filtering).',
  }),

  // — Embedder —
  // The local embedder defaults to `bge-small-en-v1.5` (the
  // model behind ADR 0006), but the model id is a user-facing
  // knob: anyone enabling vector retrieval can pin a different
  // Hugging Face model that the `Xenova/<model>` namespace hosts
  // (e.g. `all-MiniLM-L6-v2`, `gte-small`). Because changing the
  // model after vectors have been written would silently mix
  // incompatible spaces, both keys are immutable at runtime —
  // operators flip them at startup and run `embedding rebuild`
  // to migrate the stored vectors (Rule 14, ADR 0006).
  'embedder.local.model': defineKey({
    schema: z.string().min(1),
    default: 'bge-base-en-v1.5',
    mutable: false,
    description:
      'Hugging Face model id for `@psraghuveer/memento-embedder-local`. Resolved as `Xenova/<model>` on the Hub. Pinned at server start; changing it requires `embedding rebuild`.',
  }),
  'embedder.local.dimension': defineKey({
    schema: PositiveInt,
    default: 768,
    mutable: false,
    description:
      'Expected vector dimension for the configured embedder model. Must match `embedder.local.model`; the embedder rejects vectors of any other length. Pinned at server start.',
  }),
  // Resource caps on the embedder. The model's context window
  // is bounded (~512 tokens for bge-base); past that the embed
  // pass spends time tokenising input that the model will
  // truncate anyway. The byte cap protects against the DoS
  // pattern "single MCP write_memory with megabyte content"
  // while sitting comfortably above any realistic memory.
  'embedder.local.maxInputBytes': defineKey({
    schema: z
      .number()
      .int()
      .min(1_024)
      .max(1 * 1024 * 1024),
    default: 32 * 1024,
    mutable: false,
    description:
      'Maximum byte length of text passed to the local embedder. Inputs above this are truncated to the cap before tokenisation. Pinned at server start because crossing the cap would change retrieval semantics.',
  }),
  'embedder.local.timeoutMs': defineKey({
    schema: z.number().int().min(500).max(120_000),
    default: 10_000,
    mutable: false,
    description:
      'Wallclock timeout for a single embed call, in milliseconds. The embedder rejects with a typed error after this elapses; auto-embed swallows it (the memory is written without a vector and `embedding rebuild` recovers).',
  }),
  'embedder.local.cacheDir': defineKey({
    schema: z.string().min(1).nullable(),
    default: null,
    mutable: false,
    description:
      'Directory in which the local embedder caches downloaded model files. `null` resolves to `<XDG_CACHE_HOME>/memento/models` (or the platform equivalent) at startup; otherwise the literal path is used. Pinned at server start.',
  }),

  'embedding.autoEmbed': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'When true and an EmbeddingProvider is wired, newly-written memories are embedded immediately after write (fire-and-forget). Disable to defer embedding to manual `embedding rebuild` runs.',
  }),

  // — Startup backfill —
  //
  // At server boot, scan for active memories whose vector is
  // missing or stale relative to the configured embedder, and
  // batch-embed them. Recovers orphans from the prior session
  // (server died mid-async-embed, prior buggy install path,
  // user toggled `embedding.autoEmbed` from false to true,
  // etc.) without requiring an explicit `embedding rebuild`.
  // Bounded by `maxRows` so a pathological backlog cannot pin
  // boot — anything past the cap is left for the next boot or
  // the explicit rebuild command.
  //
  // Skipped entirely when no embedder is wired (vector
  // retrieval disabled in the host).
  'embedding.startupBackfill.enabled': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: false,
    description:
      'When true and an EmbeddingProvider is wired, the server runs a bounded re-embed pass at boot to drain memories whose stored vector is missing or stale. Off-thread (does not block the first request); bounded by `embedding.startupBackfill.maxRows`. Disable to require explicit `embedding rebuild` runs only.',
  }),
  'embedding.startupBackfill.maxRows': defineKey({
    schema: z.number().int().min(1).max(10_000),
    default: 1000,
    mutable: false,
    description:
      'Hard upper bound on the number of memories the startup-backfill pass scans per boot. The pass walks the active corpus newest-first and stops at this cap; remaining stale rows surface on the next boot or via `embedding rebuild`.',
  }),

  // — Scrubber —
  // Redaction is config-driven so operators can extend or
  // replace the default rule set without forking core. The
  // schema validates each rule (pattern compiles, placeholder
  // substitutions balance, ids unique); a bad override is
  // rejected at `ConfigStore` construction, not at the first
  // write.
  //
  // Both the master toggle and the rule set are immutable at
  // runtime: `config.set` from MCP must not be able to disable
  // the scrubber or weaken the rules. A prompt-injected
  // assistant calling `config.set scrubber.enabled false`
  // before writing a secret is a one-shot defence bypass we
  // cannot afford. Operators flip these at startup via
  // configuration overrides.
  'scrubber.enabled': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: false,
    description:
      'Master toggle for the write-path scrubber. When false, writes pass through unredacted and no `scrubReport` is recorded. Pinned at server start.',
  }),
  'scrubber.rules': defineKey({
    schema: ScrubberRuleSetSchema,
    default: DEFAULT_SCRUBBER_RULES,
    mutable: false,
    description:
      'Active scrubber rule set. Order is significant — first match wins. Defaults to the rules shipped in `DEFAULT_SCRUBBER_RULES`. Pinned at server start.',
  }),
  // Per-rule wallclock budget for the scrubber engine. Without
  // this, an operator-installed regex with catastrophic
  // backtracking blocks the SQLite writer thread for the full
  // duration of the match attempt. The engine aborts a rule
  // that exceeds the budget and treats it as "no match" rather
  // than failing the write — a partial scrub is preferable to
  // a refused write at the cost of the matched secret being
  // left unredacted.
  'scrubber.engineBudgetMs': defineKey({
    schema: z.number().int().min(1).max(1_000),
    default: 50,
    mutable: true,
    description:
      'Per-rule wallclock budget for the scrubber engine, in milliseconds. A rule that exceeds the budget is aborted and treated as "no match" for that rule on this write.',
  }),

  // — Privacy —
  // Per ADR-0012 §3. Operators get exactly one binary knob; the
  // *amount* of redaction is a policy decision, not a tuning
  // parameter.
  'privacy.redactSensitiveSnippets': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'When true, `memory.list` and `memory.search` project sensitive memories to a redacted view (`content: null`, `redacted: true`). `memory.read` always returns full text.',
  }),

  // — Write defaults —
  // Per principle 4 (config-driven by the user): callers should
  // not have to repeat identical values on every write. These keys
  // provide user-tunable defaults applied by the handler when the
  // corresponding field is omitted from the wire input.
  'write.defaultConfidence': defineKey({
    schema: z.number().min(0).max(1),
    default: 1,
    mutable: true,
    description:
      'Default `storedConfidence` for new memories when the caller omits the field. 1.0 means full confidence at write time; decay handles degradation over time.',
  }),
  'write.defaultPinned': defineKey({
    schema: z.boolean(),
    default: false,
    mutable: true,
    description:
      'Default `pinned` value for new memories when the caller omits the field. Pinned memories are exempt from confidence decay.',
  }),

  // — Safety —
  // Per ADR-0012 §4. Hard upper bound on `memory.write_many`
  // batch size, exposed as a knob so operators can tighten or
  // loosen it without a schema change. The repo-level write
  // path holds a single transaction across all items, so a
  // very large batch ties up the writer lock for the duration —
  // 100 is the default ceiling that balances throughput against
  // contention in the WAL-mode concurrency story.
  'safety.batchWriteLimit': defineKey({
    schema: z.number().int().min(1).max(10_000),
    default: 100,
    mutable: true,
    description:
      'Maximum number of items accepted by a single `memory.write_many` call. Requests exceeding this limit are rejected with `INVALID_INPUT` before any write runs.',
  }),

  // Per ADR-0014. Hard upper bound on how many memories a
  // single bulk-destructive call (`memory.forget_many`,
  // `memory.archive_many`) may transition in one shot. The cap
  // applies only when `dryRun: false` — dry-run rehearsals
  // observe the same filter and report `matched` regardless.
  // Default `1000` is roomy for routine clean-ups and small
  // enough that an unattended assistant cannot evict the
  // typical store; raise it via `config.set` when needed.
  'safety.bulkDestructiveLimit': defineKey({
    schema: z.number().int().min(1).max(100_000),
    default: 1000,
    mutable: true,
    description:
      'Maximum number of memories a single bulk-destructive call (`memory.forget_many`, `memory.archive_many`) may transition. Applied when `dryRun: false`; rehearsals are uncapped. Requests exceeding the cap are rejected with `INVALID_INPUT` before any row is touched.',
  }),

  // Hard upper bound on `memory.write` content length. The
  // wire-input schema additionally pins a 1 MiB ceiling beyond
  // which content is rejected outright; this key tunes the
  // operator-visible cap below that ceiling. Memento stores
  // distilled assertions, not transcripts — 64 KiB
  // accommodates any realistic memory (long ADR rationale,
  // mid-size code snippet) with margin to spare while
  // shutting down the "single-call OOM" DoS class.
  'safety.memoryContentMaxBytes': defineKey({
    schema: z
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1024),
    default: 64 * 1024,
    mutable: true,
    description:
      'Maximum byte length of `memory.write` (and supersede / extract) content. Inputs exceeding this are rejected with `INVALID_INPUT` before the scrubber or storage layer runs.',
  }),
  'safety.summaryMaxBytes': defineKey({
    schema: z
      .number()
      .int()
      .min(64)
      .max(64 * 1024),
    default: 2 * 1024,
    mutable: true,
    description:
      'Maximum byte length of `memory.write` summary. Summaries are one-line listings; the cap reflects that intent.',
  }),
  'safety.tagMaxCount': defineKey({
    schema: z.number().int().min(1).max(1024),
    default: 64,
    mutable: true,
    description:
      'Maximum number of tags accepted on a single `memory.write`. Each tag is independently capped at 64 characters by `TagSchema`.',
  }),
  // Per `docs/architecture/conflict-detection.md`, the
  // `preference` and `decision` policies parse the first line
  // of a memory's `content` as `topic: value` (or
  // `topic = value`). Content that lacks the topic-line anchor
  // silently bypasses conflict detection — two contradictory
  // preferences coexist without surfacing as a conflict. This
  // opt-in switch rejects such writes at the input boundary so
  // the failure mode is loud rather than silent. Off by default
  // because today's permissive shape is widely depended upon by
  // assistants that have not yet learned the convention.
  'safety.requireTopicLine': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      "When `true` (default), reject `memory.write`, `memory.write_many`, `memory.supersede`, and `memory.extract` calls whose `kind` is `preference` or `decision` and whose content's first non-blank line does not match the `topic: value` (or `topic = value`) convention. The rule mirrors the conflict detector's preference/decision parser — content that bypasses detection at retrieval time is rejected at write time. Flip to `false` to keep the historical permissive shape (at the cost of silent conflict-detection misses).",
  }),

  // — Extraction —
  // Auto-extraction pipeline per design proposal
  // `docs/design-proposals/auto-extraction-and-context-injection.md`.
  // The assistant dumps candidates; the server deduplicates via
  // embedding similarity against existing memories before writing.
  'extraction.enabled': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'Master switch for `memory.extract`. When false, the command returns a structured error.',
  }),
  'extraction.dedup.threshold': defineKey({
    schema: Probability,
    default: 0.85,
    mutable: true,
    description:
      'Cosine similarity floor for dedup consideration during extraction. Candidates below this are written as new.',
  }),
  'extraction.dedup.identicalThreshold': defineKey({
    schema: Probability,
    default: 0.95,
    mutable: true,
    description:
      'Cosine similarity above which a candidate is treated as a duplicate and skipped (same kind required).',
  }),
  'extraction.defaultConfidence': defineKey({
    schema: Probability,
    default: 0.8,
    mutable: true,
    description:
      'Default `storedConfidence` for memories written via `memory.extract`. Lower than manual writes so extracted memories decay faster.',
  }),
  'extraction.autoTag': defineKey({
    schema: z.string(),
    default: 'source:extracted',
    mutable: true,
    description:
      'Tag automatically added to memories written via `memory.extract`. Empty string to disable.',
  }),
  'extraction.maxCandidatesPerCall': defineKey({
    schema: PositiveInt,
    default: 20,
    mutable: true,
    description: 'Maximum number of candidates accepted by a single `memory.extract` call.',
  }),
  'extraction.processing': defineKey({
    schema: z.enum(['sync', 'async']),
    default: 'async' as const,
    mutable: true,
    description:
      'Processing mode for `memory.extract`. `async` (default) returns a receipt immediately and processes in background; `sync` blocks until all candidates are processed and returns the full results.',
  }),

  // — Context —
  // Query-less ranked retrieval per design proposal
  // `docs/design-proposals/auto-extraction-and-context-injection.md`.
  // Surfaces the most relevant memories for the current session
  // without requiring a search query.
  'context.defaultLimit': defineKey({
    schema: PositiveInt,
    default: 20,
    mutable: true,
    description:
      'Default number of memories returned by `memory.context` when no limit is supplied.',
  }),
  'context.maxLimit': defineKey({
    schema: PositiveInt,
    default: 100,
    mutable: true,
    description: 'Hard upper bound on `memory.context` result count.',
  }),
  'context.candidateLimit': defineKey({
    schema: PositiveInt,
    default: 500,
    mutable: true,
    description:
      'Maximum candidate memories the `memory.context` ranker considers per call before applying the weighted score. Pinned memories are always added regardless of this cap. Lower values keep p50 latency flat as the corpus grows; raise it to broaden the candidate pool at the cost of more ranker work.',
  }),
  'compact.run.maxBatches': defineKey({
    schema: PositiveInt,
    default: 100,
    mutable: true,
    description:
      'Safety cap on the number of batches `compact.run` will process in `mode: "drain"`. Drain stops when an iteration archives nothing OR this cap is hit, whichever happens first. Raise it for very large corpora; lower it to bound the operation in shared environments.',
  }),
  'context.includeKinds': defineKey({
    schema: z.array(z.enum(['fact', 'preference', 'decision', 'todo', 'snippet'])),
    default: ['fact', 'preference', 'decision'],
    mutable: true,
    description:
      'Which memory kinds `memory.context` includes by default. Todos and snippets are often transient.',
  }),
  'context.ranker.weights.confidence': defineKey({
    schema: z.number().min(0).finite(),
    default: 1.0,
    mutable: true,
    description: 'Context ranker weight on effective confidence.',
  }),
  'context.ranker.weights.recency': defineKey({
    schema: z.number().min(0).finite(),
    default: 1.5,
    mutable: true,
    description: 'Context ranker weight on recency (higher than search — context favours fresh).',
  }),
  'context.ranker.weights.scope': defineKey({
    schema: z.number().min(0).finite(),
    default: 2.0,
    mutable: true,
    description: 'Context ranker weight on scope match (strong: prefer local context).',
  }),
  'context.ranker.weights.pinned': defineKey({
    schema: z.number().min(0).finite(),
    default: 3.0,
    mutable: true,
    description: 'Context ranker weight for pinned memories (always surface).',
  }),
  'context.ranker.weights.frequency': defineKey({
    schema: z.number().min(0).finite(),
    default: 0.5,
    mutable: true,
    description:
      'Context ranker weight for confirmation frequency (memories confirmed often rank higher).',
  }),
  // Near-uniform-ranking hint. When `memory.context` returns a
  // page whose top-bottom score spread is below this threshold,
  // the response carries a hint suggesting the caller pass a
  // scope or call `memory.search` with a topic. The signal
  // helps an assistant recognise "the ranker has no opinion
  // here — everything's roughly tied" and act on it rather than
  // treating the order as meaningful.
  'context.hint.uniformSpreadThreshold': defineKey({
    schema: z.number().min(0).finite(),
    default: 0.05,
    mutable: true,
    description:
      'When `memory.context` returns a page whose top-bottom score spread is below this value AND the page has at least two results, the response carries a hint suggesting the caller pass a `scopes` filter or call `memory.search` with a topic for a sharper signal. Set to `0` to disable.',
  }),
  // Context-side diversity. Distinct namespace from
  // `retrieval.diversity.*` so the defaults can differ:
  // `memory.context` is the session-start survey surface where
  // distinctness is part of the contract (the caller wants
  // varied topics, not five paraphrases of the same preference).
  // `memory.search` is a query-driven surface where strict
  // relevance is usually the right answer. So context defaults
  // to gentle diversity (`lambda = 0.7`) and search defaults to
  // passthrough (`lambda = 1`).
  'context.diversity.lambda': defineKey({
    schema: Probability,
    default: 0.7,
    mutable: true,
    description:
      'MMR trade-off for `memory.context` between relevance and diversity. `1.0` is a passthrough — preserves the ranker output unchanged. `0.7` (default) gently breaks near-duplicate clusters so the session-start survey covers more topics. `0.0` is pure diversity. Memories without a stored embedding bypass the diversity penalty.',
  }),
  'context.diversity.maxDuplicates': defineKey({
    schema: PositiveInt,
    default: 5,
    mutable: true,
    description:
      'Soft ceiling on near-duplicate (cosine ≥ 0.9) candidates admitted to a `memory.context` page before the MMR pass starts skipping. Mirrors `retrieval.diversity.maxDuplicates` for the context surface.',
  }),

  // — Export —
  // Per ADR-0013. The export format is `memento-export/v1`; the
  // two knobs below tune the *defaults* the lifecycle commands
  // observe when no explicit flag is passed. Flags always win.
  'export.includeEmbeddings': defineKey({
    schema: z.boolean(),
    default: false,
    mutable: true,
    description:
      'Default for `memento export` when `--include-embeddings` is not passed. Embeddings are model-bound and rebuildable, so the default is `false`; flip to `true` only if you know the destination machine cannot rebuild them.',
  }),
  'export.defaultPath': defineKey({
    schema: z.string().min(1).nullable(),
    default: null,
    mutable: true,
    description:
      'Default destination path for `memento export` when `--out` is not passed. `null` means write to stdout; a string is treated as a filesystem path.',
  }),

  // — Import —
  // Hard upper bound on the size of a single `memento import`
  // artefact, in bytes. Without a cap, a 10 GB JSONL file is
  // read into a single Node string and OOMs the CLI before
  // parsing begins. The cap is checked via `fs.stat` before
  // the read starts.
  'import.maxBytes': defineKey({
    schema: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(8 * 1024 * 1024 * 1024),
    default: 256 * 1024 * 1024,
    mutable: true,
    description:
      'Maximum byte length of an artefact accepted by `memento import`. Files exceeding this are rejected before any read begins. Default is 256 MiB.',
  }),

  // — Packs —
  // Per ADR-0020. Memento-packs are curated YAML bundles that seed
  // a fresh store. The five knobs below cap network/IO behaviour and
  // constrain the bundled-registry path. Integrity rules (re-stamp
  // owner local-self, re-scrub on install, refuse-on-content-drift,
  // reserved `pack:` tag prefix, deterministic clientToken) are
  // hardcoded invariants per Rule 12, not config.
  'packs.bundledRegistryPath': defineKey({
    schema: z.string().min(1).nullable(),
    default: null,
    mutable: false,
    description:
      'Filesystem path to the directory containing bundled official packs. `null` defers to the runtime default (the bundled `packs/` directory shipped with the package). Pinned at server start so it cannot be flipped at runtime to point at attacker-controlled paths.',
  }),
  'packs.allowRemoteUrls': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'Master switch for `pack install --from-url`. Operators in restricted environments flip to `false` to disable HTTPS-fetch packs entirely.',
  }),
  'packs.urlFetchTimeoutMs': defineKey({
    schema: PositiveInt,
    default: 10_000,
    mutable: true,
    description:
      'Per-request timeout for `pack install --from-url`, in milliseconds. Fetches that exceed this are aborted.',
  }),
  'packs.maxPackSizeBytes': defineKey({
    schema: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024),
    default: 1 * 1024 * 1024,
    mutable: true,
    description:
      'Maximum byte length of a pack manifest accepted by `pack install`. Applies to local files and URL fetches alike. Default is 1 MiB.',
  }),
  'packs.maxMemoriesPerPack': defineKey({
    schema: z.number().int().min(1).max(10_000),
    default: 200,
    mutable: true,
    description:
      'Per-pack ceiling on the number of memories in a manifest. Manifests over this cap are rejected with `INVALID_INPUT`.',
  }),

  // — User —
  // Single-user-mode identity. The data model is multi-user-ready
  // (`OwnerRef` exists from day one, AGENTS.md rule 4) but v1
  // ships single-user only, so just one knob here: how the
  // assistant should refer to the user when authoring memory
  // content. Without this, every assistant either invents a name
  // from chat context or writes "User prefers …" — both feel off.
  'user.preferredName': defineKey({
    schema: z.string().min(1).max(64).nullable(),
    default: null,
    mutable: true,
    description:
      'How an assistant should refer to the user when writing memory content. Surfaced in `system.info` so the assistant can attribute statements (e.g. "Raghu prefers pnpm" rather than "User prefers pnpm"). When `null`, the assistant should write "The user" instead. Set with `memento config set user.preferredName "<name>"`.',
  }),
} as const;

/**
 * Union of every registered key. Use this as the parameter type
 * for any function that takes a `ConfigKey`; the compiler will
 * reject typos that string-typed keys would let through.
 */
export type ConfigKey = keyof typeof CONFIG_KEYS;

/**
 * Resolved value type for a given key. Drives `ConfigStore.get`
 * and the override map type so the store is fully typed without
 * per-key overloads.
 */
export type ConfigValueOf<K extends ConfigKey> =
  (typeof CONFIG_KEYS)[K] extends ConfigKeyDefinition<infer T> ? T : never;

/**
 * Frozen list of every registered key — useful for iteration in
 * tests and the reference-doc generator without leaking the
 * registry shape.
 */
export const CONFIG_KEY_NAMES: readonly ConfigKey[] = Object.freeze(
  Object.keys(CONFIG_KEYS) as ConfigKey[],
);

/**
 * Snapshot of every key flagged `mutable: false`. Surfaced as an
 * exported constant so non-engine consumers (notably the
 * dashboard's config editor) don't have to keep a hand-maintained
 * mirror that drifts. The derived structure means a future
 * migration that flips a key's mutability propagates to every
 * consumer at the next type-checked build.
 *
 * Order is deterministic (insertion order from `CONFIG_KEYS`),
 * which matches the order the dashboard renders rows.
 */
export const IMMUTABLE_CONFIG_KEY_NAMES: readonly ConfigKey[] = Object.freeze(
  (Object.entries(CONFIG_KEYS) as Array<[ConfigKey, ConfigKeyDefinition<unknown>]>)
    .filter(([, def]) => def.mutable === false)
    .map(([key]) => key),
);
