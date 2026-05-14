// `memory.context` command — query-less ranked retrieval.
//
// Unlike `memory.search`, this command does not take a text query.
// It retrieves the most relevant memories for the current session
// by ranking on confidence, recency, scope specificity, pinned
// status, and confirmation frequency — all signals that answer
// "what is most relevant to where you are right now?" without
// needing a user-supplied query string.
//
// Kept in its own file (like `search.ts`) because it requires
// deps that the basic `memory.*` set does not: the Kysely handle
// for event counting (frequency signal), ConfigStore for weights
// and limits, and optional scope information.
//
// Per design proposal:
//   docs/design-proposals/auto-extraction-and-context-injection.md

import type {
  MementoError,
  Memory,
  MemoryKindType,
  MemoryView,
  Scope,
  Timestamp,
} from '@psraghuveer/memento-schema';
import {
  MEMORY_KIND_TYPES,
  MemoryViewSchema,
  ScopeSchema,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ConfigStore } from '../../config/index.js';
import { type DecayConfig, decayConfigFromStore, effectiveConfidence } from '../../decay/engine.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { applyMMR } from '../../retrieval/diversity.js';
import { scopeKey } from '../../scope/resolver.js';
import type { MementoSchema } from '../../storage/schema.js';
import { repoErrorToMementoError } from '../errors.js';
import type { Command } from '../types.js';
import { computeEmbeddingStatus, projectMemoryView } from './commands.js';

const SURFACES = ['mcp', 'cli'] as const;

// — Input schema —

export const MemoryContextInputSchema = z
  .object({
    scope: ScopeSchema.optional().describe(
      'Scope to retrieve context for. When omitted, uses all active memories.',
    ),
    scopes: z
      .array(ScopeSchema)
      .optional()
      .describe('Layered scope set (most-specific first) for scope-boost ranking.'),
    limit: z.number().int().positive().optional().describe('Maximum number of memories to return.'),
    kinds: z
      .array(z.enum(MEMORY_KIND_TYPES))
      .optional()
      .describe('Filter by memory kinds. Defaults to context.includeKinds config.'),
    tags: z.array(z.string()).optional().describe('Filter by tags (AND logic).'),
    projection: z
      .enum(['full', 'summary'])
      .optional()
      .describe(
        'Response shape. `summary` (default) returns the memory view + score — the lean shape for LLM agents loading session context. `full` adds the per-component `breakdown` (confidence/recency/scope/pinned/frequency) for dashboards and debug tooling. `summary` is typically ~25-30% smaller than `full` on a top-20 page.',
      ),
  })
  .strict();

export type MemoryContextInput = z.infer<typeof MemoryContextInputSchema>;

// — Output schema —

const ContextBreakdownSchema = z
  .object({
    confidence: z.number(),
    recency: z.number(),
    scope: z.number(),
    pinned: z.number(),
    frequency: z.number(),
  })
  .strict();

// Projection mode shapes the wire response. `full` (default)
// carries the score breakdown; `summary` omits it to trim
// payload size. `breakdown` is `.optional()` so existing
// consumers that ignore `projection` keep the same TS surface.
const ContextResultSchema = z
  .object({
    memory: MemoryViewSchema,
    score: z.number(),
    breakdown: ContextBreakdownSchema.optional(),
  })
  .strict();

const MemoryContextOutputSchema = z
  .object({
    results: z.array(ContextResultSchema),
    resolvedKinds: z.array(z.enum(MEMORY_KIND_TYPES)),
    /**
     * Optional next-step nudge for the assistant. Set only when
     * the response is otherwise silent (no results) — gives a
     * clear signal that the empty array means "store is empty"
     * rather than "no relevant matches for the current scope."
     */
    hint: z.string().optional(),
  })
  .strict();

// — Deps —

export interface CreateMemoryContextCommandDeps {
  readonly db: Kysely<MementoSchema>;
  readonly memoryRepository: MemoryRepository;
  readonly configStore: ConfigStore;
  readonly clock?: () => string;
}

// — Factory —

export function createMemoryContextCommand(
  deps: CreateMemoryContextCommandDeps,
): Command<typeof MemoryContextInputSchema, typeof MemoryContextOutputSchema> {
  return {
    name: 'memory.context',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: MemoryContextInputSchema,
    outputSchema: MemoryContextOutputSchema,
    metadata: {
      description:
        'Load the most relevant memories for the current session without a search query. Uses ranked retrieval based on confidence, recency, scope, pinned status, and confirmation frequency.\n\nCall at the start of a task to load context. No arguments required — returns the top memories from config-driven defaults.\n\nEvery result\'s memory carries an `embeddingStatus` field (`"present"` | `"pending"` | `"disabled"`) so callers can tell whether a row contributed via vector similarity at all.\n\nExamples:\n\n- Default: `{}`\n- Scoped: `{"scopes":[{"type":"repo","remote":"github.com/org/app"},{"type":"global"}]}`\n- Filtered: `{"kinds":["preference","decision"],"limit":10}`',
      mcpName: 'get_memory_context',
    },
    handler: async (input) => {
      try {
        const cfg = deps.configStore;
        const limit = clampLimit(input.limit, cfg);
        const kinds: readonly MemoryKindType[] =
          input.kinds ?? (cfg.get('context.includeKinds') as MemoryKindType[]);

        // Cap the candidate fetch with `context.candidateLimit` so
        // the ranker's input size is independent of corpus size.
        // Combined with the
        // `(status, last_confirmed_at desc)` index from migration
        // 0007, this turns the previously-linear fetch into an
        // O(log n) + O(candidateLimit) operation.
        const candidateLimit = cfg.get('context.candidateLimit');
        const memories = await deps.memoryRepository.list({
          status: 'active',
          ...(kinds.length > 0 ? { kind: kinds[0] } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          limit: candidateLimit,
        });

        // If kinds has more than one entry, we need multiple fetches
        // or filter in-memory. The repo.list only takes a single kind.
        // Fetch all active with a generous limit and filter in-memory.
        let candidates: Memory[];
        if (kinds.length > 1) {
          const allMemories = await deps.memoryRepository.list({
            status: 'active',
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            limit: candidateLimit,
          });
          candidates = allMemories.filter((m) => kinds.includes(m.kind.type as MemoryKindType));
        } else if (kinds.length === 1) {
          candidates = memories;
        } else {
          candidates = await deps.memoryRepository.list({
            status: 'active',
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            limit: candidateLimit,
          });
        }

        // Pinned-supplement: pinned memories always rank highly via
        // the ranker, but the recency-ordered candidate fetch above
        // can miss old pinned rows. Pull them in unconditionally;
        // the pinned set is small and bounded by
        // `safety.pinned` policy in practice. De-dupe by id.
        const pinned = await deps.memoryRepository.list({
          status: 'active',
          pinned: true,
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          limit: candidateLimit,
        });
        if (pinned.length > 0) {
          const seen = new Set(candidates.map((m) => m.id as unknown as string));
          for (const p of pinned) {
            if (kinds.length === 0 || kinds.includes(p.kind.type as MemoryKindType)) {
              if (!seen.has(p.id as unknown as string)) {
                candidates.push(p);
                seen.add(p.id as unknown as string);
              }
            }
          }
        }

        // Post-fetch tag filter (AND logic).
        if (input.tags !== undefined && input.tags.length > 0) {
          const requiredTags = input.tags.map((t) => t.trim().toLowerCase());
          candidates = candidates.filter((m) =>
            requiredTags.every((tag) => (m.tags as readonly string[]).includes(tag)),
          );
        }

        // Fetch confirmation counts for all candidates.
        const confirmCounts = await getConfirmationCounts(
          deps.db,
          candidates.map((m) => m.id),
        );

        // Rank candidates.
        const now = (deps.clock ?? defaultClock)() as unknown as Timestamp;
        const nowMs = Date.parse(now as unknown as string);
        const decayConfig = decayConfigFromStore(deps.configStore);
        const scopeRank = buildScopeRank(input.scopes as readonly Scope[] | undefined);

        const weights = {
          confidence: cfg.get('context.ranker.weights.confidence'),
          recency: cfg.get('context.ranker.weights.recency'),
          scope: cfg.get('context.ranker.weights.scope'),
          pinned: cfg.get('context.ranker.weights.pinned'),
          frequency: cfg.get('context.ranker.weights.frequency'),
        };
        const recencyHalfLifeMs = cfg.get('retrieval.recency.halfLife');
        const scopeBoostPerLevel = cfg.get('retrieval.scopeBoost');

        const rankedRaw = rankForContext(candidates, {
          weights,
          recencyHalfLifeMs,
          scopeBoostPerLevel,
          scopeRank,
          nowMs,
          now,
          decayConfig,
          confirmCounts,
        });

        // Post-rank diversity. Default `context.diversity.lambda`
        // is `0.7` — gentle diversification by default because
        // session-start retrieval is survey-style, not lookup-
        // style. The caller asking "what should I know?" wants
        // varied topics, not five paraphrases of the same
        // preference. Memories whose stored embedding is null
        // (pending auto-embed, or vector retrieval disabled
        // when they were written) are absent from `vectorById`
        // and so bypass the similarity penalty — they ride
        // their relevance score alone.
        const lambda = cfg.get('context.diversity.lambda');
        let ranked: readonly RankedContextResult[];
        if (lambda < 1 && rankedRaw.length > 1) {
          const vectorById = new Map<string, readonly number[]>();
          for (const m of candidates) {
            const v = m.embedding?.vector;
            if (v !== undefined && v !== null) {
              vectorById.set(m.id as unknown as string, v);
            }
          }
          // Unlike `memory.search`, `memory.context` does not
          // paginate — the full ranked list is the page. So MMR
          // runs over the entire ranked output, no windowing.
          ranked = applyMMR(rankedRaw, vectorById, {
            lambda,
            maxDuplicates: cfg.get('context.diversity.maxDuplicates'),
          });
        } else {
          ranked = rankedRaw;
        }

        // Default is `summary` — lean shape for LLM agents
        // calling `get_memory_context` at session start. `full`
        // adds the score breakdown for dashboards / debug tools.
        const redact = cfg.get('privacy.redactSensitiveSnippets');
        const projection = input.projection ?? 'summary';
        const page = ranked.slice(0, limit);
        const results = page.map((r) => {
          const view = projectMemoryView(r.memory, redact) as MemoryView;
          const embeddingStatus = computeEmbeddingStatus(r.memory, deps.configStore);
          const memory = { ...view, embedding: null, embeddingStatus };
          if (projection === 'full') {
            return { memory, score: r.score, breakdown: r.breakdown };
          }
          return { memory, score: r.score };
        });

        // Set a next-step nudge in three cases:
        //   1. Empty store — capture preferences as they arise.
        //   2. Empty result page on a non-empty store — narrow
        //      the filter or use `search_memory` with a topic.
        //   3. Non-empty page whose top-bottom score spread is
        //      below `context.hint.uniformSpreadThreshold` —
        //      the ranker has no meaningful signal here and the
        //      caller should pass a `scopes` filter or use
        //      `search_memory` for sharper results.
        if (results.length === 0) {
          const totalActive = await deps.memoryRepository.list({ status: 'active', limit: 1 });
          const hint =
            totalActive.length === 0
              ? 'Store is empty. Capture user preferences as they come up via write_memory, or use extract_memory at session end.'
              : 'No memories matched the requested scope/kinds/tags. Try search_memory with a topic, or call get_memory_context with no arguments to see the global top-ranked set.';
          return ok({
            results,
            resolvedKinds: kinds as MemoryKindType[],
            hint,
          });
        }

        const uniformSpreadThreshold = cfg.get('context.hint.uniformSpreadThreshold');
        if (results.length >= 2 && uniformSpreadThreshold > 0) {
          // `length >= 2` is guarded above so both indices are
          // populated — assertions silence the biome lint while
          // keeping the runtime branch-free (`?? 0` would add
          // never-reachable nullish-coalesce branches).
          // biome-ignore lint/style/noNonNullAssertion: indices guarded by length check above.
          const top = results[0]!.score;
          // biome-ignore lint/style/noNonNullAssertion: indices guarded by length check above.
          const bottom = results[results.length - 1]!.score;
          const spread = top - bottom;
          if (spread < uniformSpreadThreshold) {
            return ok({
              results,
              resolvedKinds: kinds as MemoryKindType[],
              hint: `Returned ${results.length} results with near-uniform scores (top-bottom spread = ${spread.toFixed(4)}). The ranker has no strong signal here — pass a \`scopes\` filter for layered ranking or call search_memory with a topic for a sharper page.`,
            });
          }
        }

        return ok({
          results,
          resolvedKinds: kinds as MemoryKindType[],
        });
      } catch (caught) {
        return err<MementoError>(repoErrorToMementoError(caught, 'memory.context'));
      }
    },
  };
}

// — Internal helpers —

interface ContextBreakdown {
  readonly confidence: number;
  readonly recency: number;
  readonly scope: number;
  readonly pinned: number;
  readonly frequency: number;
}

interface RankedContextResult {
  readonly memory: Memory;
  readonly score: number;
  readonly breakdown: ContextBreakdown;
}

interface ContextRankOptions {
  readonly weights: {
    confidence: number;
    recency: number;
    scope: number;
    pinned: number;
    frequency: number;
  };
  readonly recencyHalfLifeMs: number;
  readonly scopeBoostPerLevel: number;
  readonly scopeRank: ReadonlyMap<string, number>;
  readonly nowMs: number;
  readonly now: Timestamp;
  readonly decayConfig: DecayConfig;
  readonly confirmCounts: ReadonlyMap<string, number>;
}

function rankForContext(
  candidates: readonly Memory[],
  options: ContextRankOptions,
): RankedContextResult[] {
  if (candidates.length === 0) {
    return [];
  }

  const out: RankedContextResult[] = [];
  for (const memory of candidates) {
    const confidence = effectiveConfidence(memory, options.now, options.decayConfig);

    let recency = 0;
    if (options.recencyHalfLifeMs > 0) {
      const lastMs = Date.parse(memory.lastConfirmedAt as unknown as string);
      if (!Number.isNaN(lastMs)) {
        const dt = Math.max(0, options.nowMs - lastMs);
        recency = 0.5 ** (dt / options.recencyHalfLifeMs);
      }
    }

    const rank = options.scopeRank.get(scopeKey(memory.scope));
    const scope =
      rank === undefined || options.scopeRank.size <= 1
        ? 0
        : (options.scopeRank.size - 1 - rank) * options.scopeBoostPerLevel;

    const pinned = memory.pinned ? 1 : 0;

    // Confirmation frequency: confirmCount / ageInDays, capped at 1.
    const createdMs = Date.parse(memory.createdAt as unknown as string);
    const ageMs = Math.max(1, options.nowMs - createdMs);
    const ageDays = ageMs / 86_400_000;
    const confirmCount = options.confirmCounts.get(memory.id as unknown as string) ?? 0;
    const frequency = Math.min(1, confirmCount / Math.max(1, ageDays));

    const breakdown: ContextBreakdown = { confidence, recency, scope, pinned, frequency };
    const score =
      options.weights.confidence * confidence +
      options.weights.recency * recency +
      options.weights.scope * scope +
      options.weights.pinned * pinned +
      options.weights.frequency * frequency;

    out.push({ memory, score, breakdown });
  }

  // Sort descending by score, tie-break by id descending (newer wins).
  out.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (b.memory.id as unknown as string) < (a.memory.id as unknown as string) ? -1 : 1;
  });

  return out;
}

/**
 * Count `memory.confirm` events per memory id. Uses a single
 * GROUP BY query over the events table for efficiency.
 */
async function getConfirmationCounts(
  db: Kysely<MementoSchema>,
  ids: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .selectFrom('memory_events')
    .select(['memory_id', db.fn.count<number>('id').as('cnt')])
    .where('memory_id', 'in', ids as string[])
    .where('type', '=', 'confirmed')
    .groupBy('memory_id')
    .execute();
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.memory_id, Number(row.cnt));
  }
  return map;
}

function defaultClock(): string {
  return new Date().toISOString();
}

function clampLimit(limit: number | undefined, cfg: ConfigStore): number {
  const max = cfg.get('context.maxLimit');
  const def = cfg.get('context.defaultLimit');
  if (limit === undefined) {
    return Math.min(def, max);
  }
  if (!Number.isFinite(limit) || limit < 0) {
    return Math.min(def, max);
  }
  if (limit === 0) {
    return 0;
  }
  return Math.min(Math.floor(limit), max);
}

function buildScopeRank(scopes: readonly Scope[] | undefined): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  if (scopes === undefined) {
    return map;
  }
  scopes.forEach((scope, idx) => {
    map.set(scopeKey(scope), idx);
  });
  return map;
}

export { MemoryContextOutputSchema };
