// `memory.extract` command — batch candidate extraction with
// server-side dedup.
//
// The assistant dumps "here's what seemed worth remembering" and
// the server handles the hard parts: embedding-based dedup against
// existing memories, scrubbing, conflict detection, and writing.
// The assistant's job is reduced from a multi-step workflow to a
// single batch dump.
//
// Per design proposal:
//   docs/design-proposals/auto-extraction-and-context-injection.md

import type {
  MementoError,
  Memory,
  MemoryId,
  MemoryKind,
  MemoryKindType,
  Scope,
} from '@psraghuveer/memento-schema';
import {
  MEMORY_KIND_TYPES,
  MemoryIdSchema,
  ScopeSchema,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ConfigStore } from '../../config/index.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import type { MementoSchema } from '../../storage/schema.js';
import type { Command, CommandContext } from '../types.js';

const SURFACES = ['mcp', 'cli'] as const;

// A ULID-shaped placeholder used in dry-run output so the output
// schema validates. All zeros is obviously synthetic.
const DRY_RUN_PLACEHOLDER_ID = '00000000000000000000000000' as unknown as MemoryId;

// — Input schema —

const ExtractionCandidateSchema = z
  .object({
    kind: z.enum(MEMORY_KIND_TYPES).describe('Memory kind for this candidate.'),
    content: z.string().min(1).describe('The memory content to extract.'),
    tags: z.array(z.string()).optional().describe('Optional tags for this candidate.'),
    summary: z.string().nullable().optional().describe('Optional one-line summary.'),
    rationale: z
      .string()
      .optional()
      .describe('Rationale for the decision (recommended for decision kind).'),
    language: z
      .string()
      .optional()
      .describe('Programming language (recommended for snippet kind).'),
  })
  .strict();

export const MemoryExtractInputSchema = z
  .object({
    candidates: z
      .array(ExtractionCandidateSchema)
      .min(1)
      .describe('Batch of candidate memories to extract.'),
    scope: ScopeSchema.optional().describe(
      'Scope for all candidates. Defaults to global when omitted.',
    ),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe('When true, preview what would be written without persisting.'),
  })
  .strict();

export type MemoryExtractInput = z.infer<typeof MemoryExtractInputSchema>;

// — Output schema —

const WrittenEntrySchema = z
  .object({
    id: MemoryIdSchema,
    content: z.string(),
  })
  .strict();

const SkippedEntrySchema = z
  .object({
    content: z.string(),
    reason: z.enum(['duplicate', 'scrubbed', 'invalid']),
    existingId: MemoryIdSchema.nullable(),
  })
  .strict();

const SupersededEntrySchema = z
  .object({
    id: MemoryIdSchema,
    content: z.string(),
    previousId: MemoryIdSchema,
  })
  .strict();

const MemoryExtractOutputSchema = z
  .object({
    written: z.array(WrittenEntrySchema),
    skipped: z.array(SkippedEntrySchema),
    superseded: z.array(SupersededEntrySchema),
  })
  .strict();

// — Deps —

export interface CreateMemoryExtractCommandDeps {
  readonly db: Kysely<MementoSchema>;
  readonly memoryRepository: MemoryRepository;
  readonly configStore: ConfigStore;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly afterWrite?: (memory: Memory, ctx: CommandContext) => void;
}

// — Factory —

export function createMemoryExtractCommand(
  deps: CreateMemoryExtractCommandDeps,
): Command<typeof MemoryExtractInputSchema, typeof MemoryExtractOutputSchema> {
  return {
    name: 'memory.extract',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: MemoryExtractInputSchema,
    outputSchema: MemoryExtractOutputSchema,
    metadata: {
      description:
        'Batch-extract candidate memories from a conversation. The server handles dedup against existing memories, scrubbing, and writing. The assistant\'s job is reduced to dumping "what seemed worth remembering."\n\nThe server deduplicates automatically — when in doubt, include the candidate.\n\nExample:\n\n```json\n{"candidates":[{"kind":"preference","content":"User prefers dark mode in all editors"},{"kind":"fact","content":"The production database is PostgreSQL 15"}]}\n```',
      mcpName: 'extract_memory',
    },
    handler: async (input, ctx) => {
      const cfg = deps.configStore;

      // Guard: extraction enabled?
      if (!cfg.get('extraction.enabled')) {
        return err<MementoError>({
          code: 'CONFIG_ERROR',
          message:
            'memory.extract: extraction is disabled. Enable via `memento config set extraction.enabled true`.',
          details: { key: 'extraction.enabled' },
        });
      }

      // Guard: batch size cap.
      const maxCandidates = cfg.get('extraction.maxCandidatesPerCall');
      if (input.candidates.length > maxCandidates) {
        return err<MementoError>({
          code: 'INVALID_INPUT',
          message: `memory.extract: batch size ${input.candidates.length} exceeds extraction.maxCandidatesPerCall (${maxCandidates})`,
          details: { limit: maxCandidates, received: input.candidates.length },
        });
      }

      const scope: Scope = input.scope ?? { type: 'global' };
      const autoTag = cfg.get('extraction.autoTag');
      const defaultConfidence = cfg.get('extraction.defaultConfidence');
      const dedupThreshold = cfg.get('extraction.dedup.threshold');
      const identicalThreshold = cfg.get('extraction.dedup.identicalThreshold');

      const written: { id: MemoryId; content: string }[] = [];
      const skipped: {
        content: string;
        reason: 'duplicate' | 'scrubbed' | 'invalid';
        existingId: MemoryId | null;
      }[] = [];
      const superseded: { id: MemoryId; content: string; previousId: MemoryId }[] = [];

      for (const candidate of input.candidates) {
        try {
          const result = await processCandidate(candidate, {
            scope,
            autoTag,
            defaultConfidence,
            dedupThreshold,
            identicalThreshold,
            dryRun: input.dryRun,
            deps,
            ctx,
          });

          switch (result.outcome) {
            case 'written':
              written.push({ id: result.id, content: candidate.content });
              break;
            case 'superseded':
              superseded.push({
                id: result.id,
                content: candidate.content,
                previousId: result.previousId,
              });
              break;
            case 'skipped':
              skipped.push({
                content: candidate.content,
                reason: result.reason,
                existingId: result.existingId,
              });
              break;
          }
        } catch (_caught) {
          // Partial failure: skip this candidate, continue with rest.
          skipped.push({
            content: candidate.content,
            reason: 'invalid',
            existingId: null,
          });
        }
      }

      return ok({ written, skipped, superseded });
    },
  };
}

// — Internal helpers —

interface CandidateProcessingOptions {
  readonly scope: Scope;
  readonly autoTag: string;
  readonly defaultConfidence: number;
  readonly dedupThreshold: number;
  readonly identicalThreshold: number;
  readonly dryRun: boolean;
  readonly deps: CreateMemoryExtractCommandDeps;
  readonly ctx: CommandContext;
}

type CandidateResult =
  | { readonly outcome: 'written'; readonly id: MemoryId }
  | { readonly outcome: 'superseded'; readonly id: MemoryId; readonly previousId: MemoryId }
  | {
      readonly outcome: 'skipped';
      readonly reason: 'duplicate' | 'scrubbed' | 'invalid';
      readonly existingId: MemoryId | null;
    };

/**
 * Build a fully-typed `MemoryKind` from the extraction candidate.
 * The discriminated union requires kind-specific fields.
 */
function buildMemoryKind(candidate: z.infer<typeof ExtractionCandidateSchema>): MemoryKind {
  switch (candidate.kind) {
    case 'fact':
      return { type: 'fact' };
    case 'preference':
      return { type: 'preference' };
    case 'decision':
      return { type: 'decision', rationale: candidate.rationale ?? null };
    case 'todo':
      return { type: 'todo', due: null };
    case 'snippet':
      return { type: 'snippet', language: candidate.language ?? null };
  }
}

async function processCandidate(
  candidate: z.infer<typeof ExtractionCandidateSchema>,
  options: CandidateProcessingOptions,
): Promise<CandidateResult> {
  const {
    scope,
    autoTag,
    defaultConfidence,
    dedupThreshold,
    identicalThreshold,
    dryRun,
    deps,
    ctx,
  } = options;

  // Build tags.
  const tags: string[] = candidate.tags ? [...candidate.tags] : [];
  if (autoTag.length > 0 && !tags.includes(autoTag)) {
    tags.push(autoTag);
  }

  // Build content — for decisions, append rationale if provided.
  let content = candidate.content;
  if (candidate.kind === 'decision' && candidate.rationale) {
    content = `${content}\n\nRationale: ${candidate.rationale}`;
  }
  if (candidate.kind === 'snippet' && candidate.language) {
    // Prefix language info to help with search.
    content = `[${candidate.language}] ${content}`;
  }

  // Dedup check via embedding similarity.
  const dedupResult = await checkDedup(content, candidate.kind, scope, {
    dedupThreshold,
    identicalThreshold,
    deps,
  });

  if (dedupResult.action === 'skip') {
    return {
      outcome: 'skipped',
      reason: 'duplicate',
      existingId: dedupResult.existingId,
    };
  }

  if (dryRun) {
    // In dry-run, report what would happen without writing.
    if (dedupResult.action === 'supersede') {
      return {
        outcome: 'superseded',
        id: DRY_RUN_PLACEHOLDER_ID,
        previousId: dedupResult.existingId,
      };
    }
    return {
      outcome: 'written',
      id: DRY_RUN_PLACEHOLDER_ID,
    };
  }

  // Write or supersede.
  const owner = { type: 'local' as const, id: 'self' };
  const kind = buildMemoryKind(candidate);

  if (dedupResult.action === 'supersede') {
    const result = await deps.memoryRepository.supersede(
      dedupResult.existingId,
      {
        scope,
        owner,
        kind,
        tags,
        pinned: false,
        content,
        summary: candidate.summary ?? null,
        storedConfidence: defaultConfidence,
      },
      { actor: ctx.actor },
    );
    if (deps.afterWrite) {
      try {
        deps.afterWrite(result.current, ctx);
      } catch {
        // Fire-and-forget.
      }
    }
    return {
      outcome: 'superseded',
      id: result.current.id,
      previousId: dedupResult.existingId,
    };
  }

  // Write new.
  const memory = await deps.memoryRepository.write(
    {
      scope,
      owner,
      kind,
      tags,
      pinned: false,
      content,
      summary: candidate.summary ?? null,
      storedConfidence: defaultConfidence,
    },
    { actor: ctx.actor },
  );
  if (deps.afterWrite) {
    try {
      deps.afterWrite(memory, ctx);
    } catch {
      // Fire-and-forget.
    }
  }
  return {
    outcome: 'written',
    id: memory.id,
  };
}

type DedupResult =
  | { readonly action: 'write' }
  | { readonly action: 'skip'; readonly existingId: MemoryId }
  | { readonly action: 'supersede'; readonly existingId: MemoryId };

async function checkDedup(
  content: string,
  kind: MemoryKindType,
  _scope: Scope,
  options: {
    dedupThreshold: number;
    identicalThreshold: number;
    deps: CreateMemoryExtractCommandDeps;
  },
): Promise<DedupResult> {
  const { deps, dedupThreshold, identicalThreshold } = options;

  // If no embedding provider, fall back to exact content match.
  if (deps.embeddingProvider === undefined) {
    return checkExactContentDedup(content, deps);
  }

  try {
    const queryVector = await deps.embeddingProvider.embed(content);

    // Search existing active memories for similarity.
    const { searchVector } = await import('../../retrieval/vector.js');
    const hits = await searchVector(deps.db, {
      queryVector,
      provider: {
        model: deps.embeddingProvider.model,
        dimension: deps.embeddingProvider.dimension,
      },
      limit: 5,
      statuses: ['active'],
    });

    if (hits.length === 0) {
      return { action: 'write' };
    }

    // Check the top hit.
    const topHit = hits[0];
    if (topHit === undefined) {
      return { action: 'write' };
    }
    const similarity = topHit.cosine;

    if (similarity < dedupThreshold) {
      return { action: 'write' };
    }

    // Hydrate the top hit to check its kind.
    const existing = await deps.memoryRepository.read(topHit.id);
    if (existing === null) {
      return { action: 'write' };
    }

    const sameKind = existing.kind.type === kind;

    if (sameKind && similarity >= identicalThreshold) {
      // Same kind + very high similarity → duplicate, skip.
      return { action: 'skip', existingId: topHit.id };
    }

    if (sameKind && similarity >= dedupThreshold) {
      // Same kind + moderate similarity → supersede (it's an update).
      return { action: 'supersede', existingId: topHit.id };
    }

    // Different kind → write as new (same content can be both
    // a fact and a decision).
    return { action: 'write' };
  } catch {
    // Embedding failed — fall back to exact match.
    return checkExactContentDedup(content, deps);
  }
}

async function checkExactContentDedup(
  content: string,
  deps: CreateMemoryExtractCommandDeps,
): Promise<DedupResult> {
  // Simple exact content match as fallback.
  // Search via the FTS engine for the full content string.
  // If the store has an identical content row, skip.
  try {
    const { searchFts } = await import('../../retrieval/fts.js');
    const hits = await searchFts(deps.db, {
      text: content,
      limit: 5,
      statuses: ['active'],
    });

    if (hits.length === 0) {
      return { action: 'write' };
    }

    // Hydrate and check for exact content match.
    for (const hit of hits) {
      const existing = await deps.memoryRepository.read(hit.id);
      if (existing !== null && existing.content === content) {
        return { action: 'skip', existingId: hit.id };
      }
    }

    return { action: 'write' };
  } catch {
    // If even FTS fails, just write.
    return { action: 'write' };
  }
}

export { MemoryExtractOutputSchema };
