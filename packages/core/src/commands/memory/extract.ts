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
  MemoryIdSchema,
  MemoryKindSchema,
  ScopeSchema,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ConfigStore } from '../../config/index.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import { embedBatchFallback } from '../../embedding/provider.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { ulid } from '../../repository/ulid.js';
import type { MementoSchema } from '../../storage/schema.js';
import type { Command, CommandContext } from '../types.js';
import {
  assertNoReservedTags,
  enforceSafetyCaps,
  enforceTopicLine,
  rationaleFromKind,
} from './safety-caps.js';

const SURFACES = ['mcp', 'cli'] as const;

// A ULID-shaped placeholder used in dry-run output so the output
// schema validates. All zeros is obviously synthetic.
const DRY_RUN_PLACEHOLDER_ID = '00000000000000000000000000' as unknown as MemoryId;

// — Input schema —

// ADR-0027: `memory.extract` and `memory.write` share one
// candidate shape — a discriminated-union `kind` object. The
// previous flat-kind + top-level `rationale` / `language`
// divergence was the most-warned-about footgun in the surface
// (called out in three places in the skill); it is gone.
const ExtractionCandidateSchema = z
  .object({
    kind: MemoryKindSchema.describe(
      'What kind of memory this is — same discriminated-union shape as `memory.write`. Discriminated by "type". Options: `{"type":"fact"}`, `{"type":"preference"}`, `{"type":"decision","rationale":"..."}`, `{"type":"todo","due":null}`, `{"type":"snippet","language":"typescript"}`. Per-kind fields (rationale on decision, language on snippet) live INSIDE the kind object — not as top-level siblings.',
    ),
    content: z
      .string()
      .min(1)
      .describe(
        'The memory content to extract. For `preference` and `decision` kinds, the first line MUST be `topic: value` (or `topic = value`) followed by a blank line and prose — this is what the conflict detector parses; without it, contradictory preferences silently coexist. The server rejects offending writes with `INVALID_INPUT` when `safety.requireTopicLine` is true (the default). Example: `"node-package-manager: pnpm\\n\\nUser prefers pnpm over npm."`. `fact` / `todo` / `snippet` kinds use different conflict heuristics and don\'t require this format.',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Optional tags for this candidate. Each tag is normalised (trimmed + lowercased) and validated against `[a-z0-9._:/-]` — spaces, commas, and uppercase are rejected. Pre-process human-prose values (replace spaces/commas with `-`).',
      ),
    summary: z.string().nullable().optional().describe('Optional one-line summary.'),
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
    /** Present only in async mode. A ULID identifying the background batch. */
    batchId: z.string().optional(),
    /** Present only in async mode. `'accepted'` means the batch is processing in background. */
    status: z.enum(['accepted']).optional(),
    /**
     * Always set. `'sync'` — the response arrays are authoritative
     * and the work is done. `'async'` — the response arrays will
     * always be empty; results land as memories within seconds and
     * can be confirmed via `memory.list` or `memory.search`. The
     * default mode is `async` (per `extraction.processing` config)
     * because extract is a fire-and-forget batch operation; an
     * assistant should not block on the response.
     */
    mode: z.enum(['sync', 'async']),
    /**
     * Optional next-step nudge for the assistant. Set in async mode
     * because the empty response arrays would otherwise be silent
     * about what to do or check next.
     */
    hint: z.string().optional(),
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
        'Batch-extract candidate memories from a conversation. The server handles dedup, scrubbing, and writing. The assistant\'s job is reduced to dumping "what seemed worth remembering."\n\n**Candidate shape (ADR-0027)** — `memory.extract` and `memory.write` share one shape. `kind` is a discriminated-union object: `{"type":"fact"}`, `{"type":"preference"}`, `{"type":"decision","rationale":"..."}`, `{"type":"todo","due":null}`, `{"type":"snippet","language":"typescript"}`. The per-kind fields (`rationale`, `language`) live INSIDE the kind object — not as top-level siblings.\n\n**Topic-line rule** — for `preference` and `decision` candidates, the `content` MUST start with a `topic: value` line followed by a blank line and prose. The conflict detector parses that first line; the server rejects offending writes with `INVALID_INPUT` (gated by `safety.requireTopicLine`, default true). The whole batch is rejected on the first offending candidate, not just the bad item.\n\nDedup runs at two scopes: (1) **in-batch** — byte-identical candidates within the same call collapse to a single memory (kind-aware fingerprint); (2) **cross-batch** — embeddings are compared against existing active memories via the configured similarity thresholds (≥`extraction.dedup.identicalThreshold` skips, between that and `extraction.dedup.threshold` supersedes, below writes new). When in doubt, include the candidate.\n\n**Storage defaults** — extracted memories are written at `storedConfidence: 0.8` (lower than `memory.write`\'s 1.0) so they decay faster and get pruned if never confirmed.\n\n**Processing mode** — the response carries a `mode` field. `extraction.processing` defaults to `auto` (sync for batches ≤ `extraction.syncThreshold`, async above); explicit `sync` and `async` overrides remain. When `mode: "sync"` the `written` / `skipped` / `superseded` arrays are authoritative and you can report them directly. When `mode: "async"` those arrays are intentionally empty — the server accepted the batch and is processing in background; the `hint` field explains what to expect. Do not retry on async receipts.\n\nExample (note the nested kind on every variant):\n\n```json\n{"candidates":[\n  {"kind":{"type":"preference"},"content":"editor-theme: dark\\n\\nUser prefers dark mode in all editors."},\n  {"kind":{"type":"fact"},"content":"The production database is PostgreSQL 15."},\n  {"kind":{"type":"decision","rationale":"Single-file, no daemon, FTS5 built in."},"content":"storage-engine: SQLite\\n\\nChosen for the local-first story."},\n  {"kind":{"type":"snippet","language":"shell"},"content":"memento read <id>"}\n]}\n```',
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

      // Reserved-prefix tag check (ADR-0020). Reserved namespaces
      // are owned by system commands; user-extracted memories must
      // not claim them.
      for (let i = 0; i < input.candidates.length; i += 1) {
        const candidate = input.candidates[i];
        if (candidate === undefined) continue;
        const reservedCheck = assertNoReservedTags('memory.extract', candidate.tags ?? [], i);
        if (!reservedCheck.ok) return reservedCheck;
      }
      // Per-candidate content/summary/tag/rationale caps.
      for (let i = 0; i < input.candidates.length; i += 1) {
        const candidate = input.candidates[i];
        if (candidate === undefined) continue;
        const cap = enforceSafetyCaps(
          'memory.extract',
          {
            content: candidate.content,
            summary: candidate.summary ?? null,
            tags: candidate.tags ?? [],
            rationale: rationaleFromKind(candidate.kind),
          },
          cfg,
          i,
        );
        if (!cap.ok) return cap;
        const topic = enforceTopicLine(
          'memory.extract',
          { kind: candidate.kind, content: candidate.content },
          cfg,
          i,
        );
        if (!topic.ok) return topic;
      }

      const configuredMode = cfg.get('extraction.processing');
      const syncThreshold = cfg.get('extraction.syncThreshold');
      const scope: Scope = input.scope ?? { type: 'global' };
      const autoTag = cfg.get('extraction.autoTag');
      const defaultConfidence = cfg.get('extraction.defaultConfidence');
      const dedupThreshold = cfg.get('extraction.dedup.threshold');
      const identicalThreshold = cfg.get('extraction.dedup.identicalThreshold');

      // ADR-0027: `auto` (the new default) runs sync when the
      // batch is small enough to keep response-time UX clean; the
      // explicit `sync` and `async` overrides remain for operators
      // with strict requirements. Dry-runs are always synchronous
      // regardless of mode — the caller is asking for a preview,
      // not a fire-and-forget.
      const resolvedMode: 'sync' | 'async' =
        configuredMode === 'auto'
          ? input.candidates.length <= syncThreshold
            ? 'sync'
            : 'async'
          : configuredMode;

      // ADR-0017 §2: when async mode is active and this is not a
      // dry-run, return a receipt immediately and process in
      // background. Dry-run is always synchronous.
      if (resolvedMode === 'async' && !input.dryRun) {
        const batchId = ulid();
        // Fire background processing — errors are swallowed; they
        // surface as memory events (or not-written memories).
        void processInBackground(input.candidates, {
          scope,
          autoTag,
          defaultConfidence,
          dedupThreshold,
          identicalThreshold,
          deps,
          ctx,
        });
        return ok({
          written: [],
          skipped: [],
          superseded: [],
          batchId,
          status: 'accepted' as const,
          mode: 'async' as const,
          hint: `Processing ${input.candidates.length} candidate(s) in background. Results land as memories within ~1–5 seconds; verify with list_memories or search_memory if needed. The empty arrays above are expected in async mode — no action required.`,
        });
      }

      const written: { id: MemoryId; content: string }[] = [];
      const skipped: {
        content: string;
        reason: 'duplicate' | 'scrubbed' | 'invalid';
        existingId: MemoryId | null;
      }[] = [];
      const superseded: { id: MemoryId; content: string; previousId: MemoryId }[] = [];

      // ADR-0017 §1: pre-compute all candidate contents, then
      // batch-embed upfront so the per-candidate loop never calls
      // the embedder. This turns N sequential forward passes into
      // one batch call.
      const candidateContents = input.candidates.map((c) => buildContent(c));
      let precomputedVectors: ReadonlyMap<number, readonly number[]> | undefined;
      if (deps.embeddingProvider !== undefined) {
        try {
          const vectors = await embedBatchFallback(deps.embeddingProvider, candidateContents);
          const map = new Map<number, readonly number[]>();
          for (let i = 0; i < vectors.length; i += 1) {
            const v = vectors[i];
            if (v !== undefined) map.set(i, v);
          }
          precomputedVectors = map;
        } catch {
          // Batch embed failed — fall back to per-candidate exact
          // match dedup (no vectors). This is the same degradation
          // path as when no provider is configured.
          precomputedVectors = undefined;
        }
      }

      // In-batch fingerprint set. `checkDedup` runs vector search
      // against the DB, but the auto-embed hook is fire-and-forget,
      // so earlier candidates in this batch may not have their
      // embeddings persisted yet when the next candidate's dedup
      // check runs. The map below catches byte-identical (post-
      // `buildContent`) candidates within the same call and skips
      // duplicates without round-tripping through vector search.
      const seenInBatch = new Map<string, MemoryId>();

      for (let i = 0; i < input.candidates.length; i += 1) {
        const candidate = input.candidates[i];
        if (candidate === undefined) continue;
        const fingerprint = batchFingerprint(candidate, candidateContents[i] ?? '');
        const priorInBatch = seenInBatch.get(fingerprint);
        if (priorInBatch !== undefined) {
          skipped.push({
            content: candidate.content,
            reason: 'duplicate',
            existingId: priorInBatch,
          });
          continue;
        }
        try {
          const vec = precomputedVectors?.get(i);
          const result = await processCandidate(candidate, {
            scope,
            autoTag,
            defaultConfidence,
            dedupThreshold,
            identicalThreshold,
            dryRun: input.dryRun,
            deps,
            ctx,
            ...(vec !== undefined ? { precomputedVector: vec } : {}),
          });

          switch (result.outcome) {
            case 'written':
              written.push({ id: result.id, content: candidate.content });
              seenInBatch.set(fingerprint, result.id);
              break;
            case 'superseded':
              superseded.push({
                id: result.id,
                content: candidate.content,
                previousId: result.previousId,
              });
              seenInBatch.set(fingerprint, result.id);
              break;
            case 'skipped':
              skipped.push({
                content: candidate.content,
                reason: result.reason,
                existingId: result.existingId,
              });
              if (result.existingId !== null) {
                seenInBatch.set(fingerprint, result.existingId);
              }
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

      return ok({ written, skipped, superseded, mode: 'sync' as const });
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
  /** Pre-computed embedding vector from the batch-embed pass (ADR-0017). */
  readonly precomputedVector?: readonly number[];
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
 * Build the final content string for a candidate. Extracted so
 * the handler can pre-compute contents for batch embedding
 * (ADR-0017) without duplicating the rationale/language logic.
 *
 * Reads from the nested kind shape (ADR-0027). `rationale` and
 * `language` live on the kind, not at the top level.
 */
function buildContent(candidate: z.infer<typeof ExtractionCandidateSchema>): string {
  let content = candidate.content;
  if (candidate.kind.type === 'decision' && candidate.kind.rationale) {
    content = `${content}\n\nRationale: ${candidate.kind.rationale}`;
  }
  if (candidate.kind.type === 'snippet' && candidate.kind.language) {
    content = `[${candidate.kind.language}] ${content}`;
  }
  return content;
}

/**
 * Promote the extract candidate's nested kind to the canonical
 * `MemoryKind` shape. After ADR-0027 the candidate's `kind`
 * already conforms to `MemoryKindSchema`, so this is the
 * identity — but kept as a named helper so call sites read as
 * intent ("convert candidate into a write-ready kind") rather
 * than a bare property access, and so the wrapper survives
 * future per-kind transformations without churning callers.
 */
function buildMemoryKind(candidate: z.infer<typeof ExtractionCandidateSchema>): MemoryKind {
  return candidate.kind;
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
    precomputedVector,
  } = options;

  // Build tags.
  const tags: string[] = candidate.tags ? [...candidate.tags] : [];
  if (autoTag.length > 0 && !tags.includes(autoTag)) {
    tags.push(autoTag);
  }

  const content = buildContent(candidate);

  // Dedup check via embedding similarity. When a pre-computed
  // vector is available (ADR-0017 batch-embed pass), skip the
  // per-candidate embed call inside checkDedup.
  const dedupResult = await checkDedup(content, candidate.kind.type, scope, {
    dedupThreshold,
    identicalThreshold,
    deps,
    ...(precomputedVector !== undefined ? { precomputedVector } : {}),
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
    /** Pre-computed embedding vector from the batch-embed pass (ADR-0017). */
    precomputedVector?: readonly number[];
  },
): Promise<DedupResult> {
  const { deps, dedupThreshold, identicalThreshold, precomputedVector } = options;

  // If no embedding provider, fall back to exact content match.
  if (deps.embeddingProvider === undefined) {
    return checkExactContentDedup(content, kind, deps);
  }

  try {
    // ADR-0017: use the pre-computed vector when available,
    // avoiding a redundant per-candidate embed call.
    const queryVector = precomputedVector ?? (await deps.embeddingProvider.embed(content));

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
    return checkExactContentDedup(content, kind, deps);
  }
}

async function checkExactContentDedup(
  content: string,
  kind: MemoryKindType,
  deps: CreateMemoryExtractCommandDeps,
): Promise<DedupResult> {
  // Simple exact-content match as fallback when no embedding
  // provider is wired. Returns skip only when the matching memory
  // is also the same kind — the extract handler treats the same
  // prose recorded as both a `fact` and a `decision` as two
  // distinct memories (mirrors the kind check in `checkDedup`).
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

    // Hydrate and check for exact content + same kind match.
    for (const hit of hits) {
      const existing = await deps.memoryRepository.read(hit.id);
      if (existing !== null && existing.content === content && existing.kind.type === kind) {
        return { action: 'skip', existingId: hit.id };
      }
    }

    return { action: 'write' };
  } catch {
    // If even FTS fails, just write.
    return { action: 'write' };
  }
}

// — Async background processing (ADR-0017 §2) —

interface BackgroundProcessingOptions {
  readonly scope: Scope;
  readonly autoTag: string;
  readonly defaultConfidence: number;
  readonly dedupThreshold: number;
  readonly identicalThreshold: number;
  readonly deps: CreateMemoryExtractCommandDeps;
  readonly ctx: CommandContext;
}

/**
 * Process candidates in background. Errors per-candidate are
 * swallowed — they will surface as memory events or simply as
 * not-written memories. The caller has already returned the
 * receipt to the client.
 */
async function processInBackground(
  candidates: readonly z.infer<typeof ExtractionCandidateSchema>[],
  options: BackgroundProcessingOptions,
): Promise<void> {
  const { scope, autoTag, defaultConfidence, dedupThreshold, identicalThreshold, deps, ctx } =
    options;

  // Batch-embed upfront, same as sync path.
  const candidateContents = candidates.map((c) => buildContent(c));
  let precomputedVectors: ReadonlyMap<number, readonly number[]> | undefined;
  if (deps.embeddingProvider !== undefined) {
    try {
      const vectors = await embedBatchFallback(deps.embeddingProvider, candidateContents);
      const map = new Map<number, readonly number[]>();
      for (let i = 0; i < vectors.length; i += 1) {
        const v = vectors[i];
        if (v !== undefined) map.set(i, v);
      }
      precomputedVectors = map;
    } catch {
      precomputedVectors = undefined;
    }
  }

  // Same in-batch fingerprint guard as the sync path. See the comment
  // there for the auto-embed-hook timing rationale.
  const seenInBatch = new Map<string, MemoryId>();

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    const fingerprint = batchFingerprint(candidate, candidateContents[i] ?? '');
    if (seenInBatch.has(fingerprint)) continue;
    try {
      const vec = precomputedVectors?.get(i);
      const result = await processCandidate(candidate, {
        scope,
        autoTag,
        defaultConfidence,
        dedupThreshold,
        identicalThreshold,
        dryRun: false,
        deps,
        ctx,
        ...(vec !== undefined ? { precomputedVector: vec } : {}),
      });
      if (result.outcome === 'written' || result.outcome === 'superseded') {
        seenInBatch.set(fingerprint, result.id);
      } else if (result.outcome === 'skipped' && result.existingId !== null) {
        seenInBatch.set(fingerprint, result.existingId);
      }
    } catch {
      // Swallow — partial failure is acceptable in background mode.
    }
  }
}

/**
 * Compute the in-batch dedup fingerprint for a candidate. Same
 * `(kind, normalized-content)` keying covers the byte-identical case
 * (the original stress finding) and trivial whitespace / case noise.
 * The kind is part of the key so the same prose recorded as both a
 * `fact` and a `decision` is two memories, not one.
 */
function batchFingerprint(
  candidate: z.infer<typeof ExtractionCandidateSchema>,
  builtContent: string,
): string {
  return `${candidate.kind.type}|${builtContent.normalize('NFC').trim().toLowerCase()}`;
}

export { MemoryExtractOutputSchema };
