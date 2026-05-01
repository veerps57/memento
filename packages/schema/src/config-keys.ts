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
      'Per-write detection budget in milliseconds. Hook runs that exceed this are dropped with a `conflict.timeout` warning; recovery is via `conflict.scan`.',
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

  // — Retrieval —
  // Pipeline shape per `docs/architecture/retrieval.md`. FTS5 is
  // always available; vector search is opt-in. The ranker is a
  // configurable linear combination — every weight is a key here
  // so operators can tune recall vs. precision without code
  // changes (principle 1: configurable defaults).
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
    schema: z.enum(['linear']),
    default: 'linear',
    mutable: true,
    description:
      'Ranker strategy. `linear` is the shipping strategy; the enum can be widened without breaking existing configs.',
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
      'Maximum FTS5 candidates fetched per query before ranking. Keeps the ranker fast at the cost of recall on very-frequent terms.',
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

  'embedding.autoEmbed': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'When true and an EmbeddingProvider is wired, newly-written memories are embedded immediately after write (fire-and-forget). Disable to defer embedding to manual `embedding rebuild` runs.',
  }),

  // — Scrubber —
  // Redaction is config-driven so operators can extend or
  // replace the default rule set without forking core. The
  // schema validates each rule (pattern compiles, placeholder
  // substitutions balance, ids unique); a bad override is
  // rejected at `ConfigStore` construction, not at the first
  // write.
  'scrubber.enabled': defineKey({
    schema: z.boolean(),
    default: true,
    mutable: true,
    description:
      'Master toggle for the write-path scrubber. When false, writes pass through unredacted and no `scrubReport` is recorded.',
  }),
  'scrubber.rules': defineKey({
    schema: ScrubberRuleSetSchema,
    default: DEFAULT_SCRUBBER_RULES,
    mutable: true,
    description:
      'Active scrubber rule set. Order is significant — first match wins. Defaults to the rules shipped in `DEFAULT_SCRUBBER_RULES`.',
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
