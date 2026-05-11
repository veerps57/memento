// `memory.search` command — registry-side wrapper around the
// retrieval pipeline.
//
// Kept in its own file (and behind its own factory) because it
// needs different deps from the rest of `memory.*`: the engine
// reads the `Kysely` handle for FTS, the repository for
// hydration, and a `ConfigStore` for weights and limits. Folding
// those into `createMemoryCommands` would force every host that
// only wants the data-plane commands to wire up search-only
// dependencies. The two factories compose at the call site
// instead.
//
// The output schema mirrors the engine's `SearchResult` exactly,
// so downstream consumers (CLI table renderer, MCP JSON
// response) can rely on the score breakdown for explainability —
// "why did this rank above that?" is one of the questions the
// retrieval architecture explicitly promises to answer.

import type { Conflict, MementoError, MemoryView, Scope } from '@psraghuveer/memento-schema';
import {
  ConflictIdSchema,
  MEMORY_KIND_TYPES,
  MemoryIdSchema,
  MemoryViewSchema,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ConfigStore } from '../../config/index.js';
import type { ConflictRepository } from '../../conflict/index.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { searchMemories } from '../../retrieval/index.js';
import type { SearchPage } from '../../retrieval/index.js';
import type { MementoSchema } from '../../storage/schema.js';
import { repoErrorToMementoError } from '../errors.js';
import type { Command } from '../types.js';
import { computeEmbeddingStatus, projectMemoryView } from './commands.js';
import { MemorySearchInputSchema } from './search-input.js';

// `memory.search` is the dashboard's primary read surface — every
// search bar maps to it. Dashboard opt-in.
const SURFACES = ['mcp', 'cli', 'dashboard'] as const;

/**
 * Output schema. Score and breakdown components are unbounded
 * `z.number()` (not `min/max(1)`) because adapter-side weights
 * may legitimately push the linear sum above 1 — the breakdown
 * stays in [0,1] per component but the composite score does
 * not. The breakdown is documented in the retrieval ranker.
 *
 * Envelope shape: `{ results, nextCursor }`. `nextCursor` is
 * `null` on the last page; pass it back as the `cursor` input
 * field to fetch the next slice.
 */
const ScoreBreakdownSchema = z
  .object({
    fts: z.number(),
    vector: z.number(),
    confidence: z.number(),
    recency: z.number(),
    scope: z.number(),
    pinned: z.number(),
  })
  .strict();

/**
 * Open-conflict marker attached to a search result when
 * `conflict.surfaceInSearch` is enabled and a `ConflictRepository`
 * was provided to the search command. Present (possibly empty)
 * on every result so consumers can rely on the field shape
 * regardless of the flag.
 *
 * `otherMemoryId` is the side of the conflict that is **not**
 * the result memory itself — i.e. "this memory conflicts with
 * `otherMemoryId` via conflict `conflictId`". `kind` mirrors
 * the conflict's kind so the UI can group / colour without a
 * second lookup.
 */
const ConflictRefSchema = z
  .object({
    conflictId: ConflictIdSchema,
    otherMemoryId: MemoryIdSchema,
    kind: z.enum(MEMORY_KIND_TYPES),
  })
  .strict();

const SearchResultSchema = z
  .object({
    memory: MemoryViewSchema,
    score: z.number(),
    breakdown: ScoreBreakdownSchema,
    conflicts: z.array(ConflictRefSchema),
  })
  .strict();

const MemorySearchOutputSchema = z
  .object({
    results: z.array(SearchResultSchema),
    nextCursor: MemoryIdSchema.nullable(),
  })
  .strict();

export interface CreateMemorySearchCommandDeps {
  readonly db: Kysely<MementoSchema>;
  readonly memoryRepository: MemoryRepository;
  readonly configStore: ConfigStore;
  /**
   * Optional conflict repository. When provided **and**
   * `conflict.surfaceInSearch` resolves to `true`, each search
   * result is annotated with the open conflicts it participates
   * in. When omitted, every result carries an empty `conflicts`
   * array — hosts that don't run the conflict subsystem stay
   * fully functional.
   */
  readonly conflictRepository?: ConflictRepository;
  /**
   * Optional embedding provider. Required at runtime iff
   * `retrieval.vector.enabled` is true; the pipeline raises a
   * structured CONFIG_ERROR otherwise. Hosts that never enable
   * vector retrieval can omit this field entirely.
   */
  readonly embeddingProvider?: EmbeddingProvider;
  /** Optional clock override. Defaults to wall-clock `new Date()`. */
  readonly clock?: () => string;
}

/**
 * Build the `memory.search` command bound to a retrieval deps
 * object. The handler delegates to `searchMemories` and projects
 * any thrown error through `repoErrorToMementoError` for parity
 * with the rest of the `memory.*` set.
 */
export function createMemorySearchCommand(
  deps: CreateMemorySearchCommandDeps,
): Command<typeof MemorySearchInputSchema, typeof MemorySearchOutputSchema> {
  return {
    name: 'memory.search',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: MemorySearchInputSchema,
    outputSchema: MemorySearchOutputSchema,
    metadata: {
      description:
        'Search memories by free text using FTS5 + the configured linear ranker.\n\nExamples:\n\n- Simple: `{"text":"database migration"}`\n- With filters: `{"text":"auth","kinds":["decision","fact"],"limit":5}`',
    },
    handler: async (input, ctx) => {
      try {
        const page = await searchMemories(
          deps,
          {
            text: input.text,
            ...(input.scopes !== undefined ? { scopes: input.scopes as readonly Scope[] } : {}),
            ...(input.includeStatuses !== undefined
              ? { includeStatuses: input.includeStatuses }
              : {}),
            ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
            ...(input.now !== undefined ? { now: input.now } : {}),
            ...(input.createdAtAfter !== undefined ? { createdAtAfter: input.createdAtAfter } : {}),
            ...(input.createdAtBefore !== undefined
              ? { createdAtBefore: input.createdAtBefore }
              : {}),
            ...(input.confirmedAfter !== undefined ? { confirmedAfter: input.confirmedAfter } : {}),
            ...(input.confirmedBefore !== undefined
              ? { confirmedBefore: input.confirmedBefore }
              : {}),
          },
          { actor: ctx.actor },
        );
        const annotated = await annotateWithConflicts(deps, page);
        const stripEmbedding = !(input.includeEmbedding === true);
        return ok({
          ...annotated,
          results: annotated.results.map((r) => {
            const embeddingStatus = computeEmbeddingStatus(r.memory, deps.configStore);
            return {
              ...r,
              memory: stripEmbedding
                ? { ...r.memory, embedding: null, embeddingStatus }
                : { ...r.memory, embeddingStatus },
            };
          }),
        });
      } catch (caught) {
        return err<MementoError>(repoErrorToMementoError(caught, 'memory.search'));
      }
    },
  };
}

/**
 * Attach `conflicts: ConflictRef[]` to every result in `page`.
 *
 * The annotation happens after retrieval (rather than inside the
 * ranker) because conflict surfacing is a presentation concern,
 * not a ranking signal: surfacing must not change the order or
 * scores of results, only enrich them.
 *
 * When the flag is off or no `conflictRepository` was wired,
 * every result is annotated with `conflicts: []` so the field
 * shape is stable. When on, we issue one `list` call per result
 * memory — typical search pages are small (≤ 50) and the
 * `conflicts(memory_id)` indexes hit; if profiling later shows
 * this is hot, a batch filter can be added without touching
 * this call site.
 */
type AnnotatedResult = {
  memory: MemoryView;
  score: SearchPage['results'][number]['score'];
  breakdown: SearchPage['results'][number]['breakdown'];
  conflicts: z.infer<typeof ConflictRefSchema>[];
};

interface AnnotatedSearchPage {
  readonly results: AnnotatedResult[];
  readonly nextCursor: SearchPage['nextCursor'];
}

async function annotateWithConflicts(
  deps: CreateMemorySearchCommandDeps,
  page: SearchPage,
): Promise<AnnotatedSearchPage> {
  // ADR-0012 §3: project sensitive rows through the redacted
  // view when `privacy.redactSensitiveSnippets` is on. The
  // projection happens before conflict annotation so a sensitive
  // row in an open conflict still gets its `conflicts` array,
  // just with `content: null`.
  const redact = deps.configStore.get('privacy.redactSensitiveSnippets');
  const surface = deps.configStore.get('conflict.surfaceInSearch');
  const repo = deps.conflictRepository;
  if (!surface || repo === undefined) {
    return {
      ...page,
      results: page.results.map((r) => ({
        memory: projectMemoryView(r.memory, redact),
        score: r.score,
        breakdown: r.breakdown,
        conflicts: [],
      })),
    };
  }

  const enriched = await Promise.all(
    page.results.map(async (r): Promise<AnnotatedResult> => {
      const open = await repo.list({ open: true, memoryId: r.memory.id });
      const conflicts = open.map((c) => toConflictRef(c, r.memory.id));
      return {
        memory: projectMemoryView(r.memory, redact),
        score: r.score,
        breakdown: r.breakdown,
        conflicts,
      };
    }),
  );
  return { ...page, results: enriched };
}

function toConflictRef(
  c: Conflict,
  selfId: Conflict['newMemoryId'],
): z.infer<typeof ConflictRefSchema> {
  const otherMemoryId = c.newMemoryId === selfId ? c.conflictingMemoryId : c.newMemoryId;
  return { conflictId: c.id, otherMemoryId, kind: c.kind };
}

export { MemorySearchInputSchema, MemorySearchOutputSchema };
