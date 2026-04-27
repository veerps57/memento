// Retrieval pipeline orchestrator.
//
// Composes the stages from `docs/architecture/retrieval.md`:
//   query → scope filter → candidate generation → ranker → results
//
// In v1 only the FTS stage is wired; vector candidates land
// behind `retrieval.vector.enabled` once an embedder is plumbed
// through. The shape here is intentionally vector-aware so that
// future commit is additive.

import type { ActorRef, Memory, MemoryId, Scope } from '@psraghuveer/memento-schema';
import { assertNever } from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import type { ConfigStore } from '../config/index.js';
import { decayConfigFromStore } from '../decay/engine.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { MemoryRepository } from '../repository/memory-repository.js';
import type { MementoSchema } from '../storage/schema.js';
import { searchFts } from './fts.js';
import { type RankerOptions, rankLinear } from './ranker.js';
import type { RawCandidate, SearchPage, SearchQuery, SearchResult } from './types.js';
import { StaleEmbeddingError, searchVector } from './vector.js';

export interface SearchDeps {
  readonly db: Kysely<MementoSchema>;
  readonly memoryRepository: MemoryRepository;
  readonly configStore: ConfigStore;
  /**
   * Optional embedding provider. Required at runtime iff
   * `retrieval.vector.enabled` is true; absence with the flag
   * on raises a typed `VectorRetrievalConfigError` so the
   * command surface can map it to a structured CONFIG_ERROR.
   * When the flag is off this field is ignored.
   */
  readonly embeddingProvider?: EmbeddingProvider;
  /**
   * Optional clock used when the query does not supply `now`.
   * Threaded so tests are deterministic without mocking globals.
   */
  readonly clock?: () => string;
}

/**
 * Thrown by {@link searchMemories} when the configured
 * retrieval.vector.* combination is internally inconsistent
 * with what the host wired (e.g. flag on but no provider, or a
 * row exists with a stale embedding model).
 *
 * The command surface (`memory.search`) catches this and emits
 * a CONFIG_ERROR with the same human-readable message, so MCP
 * / CLI users see a structured error rather than a stack trace.
 */
export class VectorRetrievalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorRetrievalConfigError';
  }
}

const DEFAULT_STATUSES = ['active'] as const;

/**
 * Run a search query end-to-end and return ranked results.
 *
 * The function is async only because the FTS stage hits SQLite;
 * everything after the candidate fetch is in-memory and pure
 * over `(candidates, memories, weights, now)`.
 *
 * `actor` is accepted for symmetry with the rest of the
 * repository surface but is not currently logged — search is a
 * read-only operation per ADR-0003 and emits no `MemoryEvent`.
 * The parameter is reserved for future use (e.g. surfaceing
 * recently-confirmed memories from the same actor).
 */
export async function searchMemories(
  deps: SearchDeps,
  query: SearchQuery,
  _ctx?: { readonly actor: ActorRef },
): Promise<SearchPage> {
  const cfg = deps.configStore;

  const vectorEnabled = cfg.get('retrieval.vector.enabled');
  if (vectorEnabled && deps.embeddingProvider === undefined) {
    // The flag promises a vector union; the host did not wire
    // a provider. Silently degrading to FTS-only would hide a
    // configuration mistake — surface it instead, with an
    // actionable message.
    throw new VectorRetrievalConfigError(
      'memory.search: retrieval.vector.enabled is true but no EmbeddingProvider was wired into the host; either disable the flag (`memento config set retrieval.vector.enabled false`) or supply an embedder when constructing the app.',
    );
  }

  const backend = cfg.get('retrieval.vector.backend');
  // Exhaustive backend dispatch. v1 ships only `brute-force`;
  // `auto` resolves to it. The enum is intentionally narrow
  // (see config-keys.ts) so widening this switch is the only
  // place a future `sqlite-vec` arm needs to land.
  type VectorBackend = 'auto' | 'brute-force';
  const resolvedBackend: VectorBackend = ((): VectorBackend => {
    switch (backend as VectorBackend) {
      case 'auto':
        return 'brute-force';
      case 'brute-force':
        return 'brute-force';
      default:
        return assertNever(backend as never);
    }
  })();

  const limit = clampLimit(query.limit, cfg);
  if (limit === 0) {
    return { results: [], nextCursor: null };
  }

  const statuses = query.includeStatuses ?? DEFAULT_STATUSES;
  if (statuses.length === 0) {
    return { results: [], nextCursor: null };
  }

  const ftsLimit = cfg.get('retrieval.candidate.ftsLimit');

  const ftsHits = await searchFts(deps.db, {
    text: query.text,
    limit: ftsLimit,
    statuses,
    ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
    ...(query.scopes !== undefined ? { scopes: query.scopes } : {}),
  });

  // Build the candidate set as a union by id of FTS hits and
  // (when enabled) cosine matches from the vector scanner. The
  // ranker already accepts `RawCandidate { bm25, cosine }` with
  // either field nullable, so a memory that only matched FTS
  // gets a null cosine and vice-versa — the linear combination
  // simply zeroes the missing arm.
  const candidatesById = new Map<string, RawCandidate>();
  for (const hit of ftsHits) {
    candidatesById.set(hit.id as unknown as string, {
      id: hit.id,
      bm25: hit.bm25,
      cosine: null,
    });
  }

  if (vectorEnabled && deps.embeddingProvider !== undefined) {
    const provider = deps.embeddingProvider;
    const queryVector = await provider.embed(query.text);
    const vectorLimit = cfg.get('retrieval.candidate.vectorLimit');
    try {
      // `resolvedBackend` will branch when `sqlite-vec` lands;
      // for v1 every value resolves to `brute-force`. Reading
      // it here ties the dispatch decision to the candidate
      // generation site (one place to grep).
      void resolvedBackend;
      const vectorHits = await searchVector(deps.db, {
        queryVector,
        provider: { model: provider.model, dimension: provider.dimension },
        limit: vectorLimit,
        statuses,
        ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
        ...(query.scopes !== undefined ? { scopes: query.scopes } : {}),
      });
      for (const hit of vectorHits) {
        const key = hit.id as unknown as string;
        const existing = candidatesById.get(key);
        if (existing === undefined) {
          candidatesById.set(key, { id: hit.id, bm25: null, cosine: hit.cosine });
        } else {
          candidatesById.set(key, { ...existing, cosine: hit.cosine });
        }
      }
    } catch (caught) {
      if (caught instanceof StaleEmbeddingError) {
        // Re-wrap as the pipeline-typed config error so the
        // command surface can produce a CONFIG_ERROR with a
        // single catch-clause shape. The original error is
        // preserved on `.cause` for diagnostics.
        throw Object.assign(new VectorRetrievalConfigError(caught.message), { cause: caught });
      }
      throw caught;
    }
  }

  const candidates: RawCandidate[] = Array.from(candidatesById.values());
  if (candidates.length === 0) {
    return { results: [], nextCursor: null };
  }

  const memories = await deps.memoryRepository.readMany(candidates.map((c) => c.id));
  const byId = new Map<string, Memory>();
  for (const m of memories) {
    byId.set(m.id as unknown as string, m);
  }

  const now =
    query.now ??
    ((deps.clock ?? defaultClock)() as unknown as SearchQuery['now']) ??
    defaultClock();

  const ranked: readonly SearchResult[] = rankByStrategy(
    cfg.get('retrieval.ranker.strategy') as RankerStrategy,
    candidates,
    byId,
    {
      weights: {
        fts: cfg.get('retrieval.ranker.weights.fts'),
        vector: cfg.get('retrieval.ranker.weights.vector'),
        confidence: cfg.get('retrieval.ranker.weights.confidence'),
        recency: cfg.get('retrieval.ranker.weights.recency'),
        scope: cfg.get('retrieval.ranker.weights.scope'),
        pinned: cfg.get('retrieval.ranker.weights.pinned'),
      },
      recencyHalfLifeMs: cfg.get('retrieval.recency.halfLife'),
      scopeBoostPerLevel: cfg.get('retrieval.scopeBoost'),
      ...(query.scopes !== undefined ? { scopes: query.scopes as readonly Scope[] } : {}),
      now: now as never,
      decayConfig: decayConfigFromStore(deps.configStore),
    },
  );

  // Cursor advances past the named id. A stale cursor (id not
  // present in the current ranked set) yields an empty page —
  // graceful degradation beats throwing on what is essentially
  // a client/server clock-skew artefact.
  const startIdx =
    query.cursor === undefined ? 0 : findCursorStart(ranked, query.cursor as unknown as string);
  if (startIdx === -1) {
    return { results: [], nextCursor: null };
  }

  const endIdx = startIdx + limit;
  const pageResults = ranked.slice(startIdx, endIdx);
  const hasMore = endIdx < ranked.length;
  const nextCursor: MemoryId | null =
    hasMore && pageResults.length > 0
      ? (pageResults[pageResults.length - 1]?.memory.id as MemoryId)
      : null;

  return { results: pageResults, nextCursor };
}

function findCursorStart(ranked: readonly { readonly memory: Memory }[], cursorId: string): number {
  for (let i = 0; i < ranked.length; i += 1) {
    if ((ranked[i]?.memory.id as unknown as string) === cursorId) {
      return i + 1;
    }
  }
  return -1;
}

function defaultClock(): string {
  return new Date().toISOString();
}

function clampLimit(limit: number | undefined, cfg: ConfigStore): number {
  const max = cfg.get('retrieval.search.maxLimit');
  const def = cfg.get('retrieval.search.defaultLimit');
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

/**
 * Dispatch ranking by configured strategy. The exhaustive
 * `assertNever` is the totality guarantee — widening this
 * `RankerStrategy` literal union without adding a case here is
 * a TypeScript error, not a runtime surprise. Mirrors the
 * discriminated-union pattern used for `MemoryKind` and
 * `Scope` (AGENTS.md rule 7).
 *
 * `RankerStrategy` must mirror the values of
 * `retrieval.ranker.strategy` in `@psraghuveer/memento-schema/config-keys`.
 * A structural test (`test/retrieval/ranker-strategy.test.ts`)
 * fails the build if the two diverge, so widening the enum on
 * one side without the other is detected before the binary
 * ships.
 */
type RankerStrategy = 'linear';

function rankByStrategy(
  strategy: RankerStrategy,
  candidates: readonly RawCandidate[],
  memories: ReadonlyMap<string, Memory>,
  options: RankerOptions,
): SearchResult[] {
  switch (strategy) {
    case 'linear':
      return rankLinear(candidates, memories, options);
    default:
      return assertNever(strategy);
  }
}
