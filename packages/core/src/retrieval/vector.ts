// Vector candidate generation.
//
// Cosine-similarity matches over `memories.embedding_json` are
// the second arm of the retrieval pipeline (`docs/architecture/
// retrieval.md`); they recover relevance for queries whose
// terms are paraphrased rather than literal. v1 ships only the
// `brute-force` backend — every active row with an embedding is
// scanned in-memory per query. A native `sqlite-vec` backend is
// planned and will widen `retrieval.vector.backend`; see ADR
// 0006 for why local-only / brute-force is the v1 default.
//
// Three non-obvious behaviours documented up front:
//
// 1. Stale-embedding policy. The `model` and `dimension`
//    embedded into every row let the scanner detect rows that
//    were embedded with a different model than the configured
//    provider (e.g. operator changed `embedder.local.model`
//    without running `embedding rebuild`). Mixing vector spaces
//    silently corrupts ranking, so the scanner THROWS on the
//    first stale row. The error message points at `embedding
//    rebuild`. Rule 14 (memory file): embedding model migration
//    must be explicit.
//
// 2. Identifier safety. Filter values (`statuses`, `kinds`,
//    `scopes`) are rendered as `sql.lit(...)` rather than bound
//    parameters because they are sourced exclusively from
//    closed enums in `@psraghuveer/memento-schema`; the user-controlled
//    `embedding_json` payload is read back as a TEXT column and
//    `JSON.parse`d, never spliced into SQL. No SQL injection
//    surface.
//
// 3. The scanner is independent of FTS. It runs over the full
//    eligible row set and returns up to `limit` candidates
//    ordered by cosine similarity descending. The pipeline
//    layer (pipeline.ts) unions FTS hits and vector hits by id;
//    this module is responsible only for "give me the top-K
//    cosine matches".

import {
  type Embedding,
  EmbeddingSchema,
  type MemoryId,
  type MemoryKindType,
  type Scope,
  type Timestamp,
} from '@psraghuveer/memento-schema';
import { type Kysely, sql } from 'kysely';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { MementoSchema } from '../storage/schema.js';

export interface VectorSearchOptions {
  readonly queryVector: readonly number[];
  readonly provider: Pick<EmbeddingProvider, 'model' | 'dimension'>;
  readonly limit: number;
  readonly statuses: readonly ('active' | 'superseded' | 'forgotten' | 'archived')[];
  readonly kinds?: readonly MemoryKindType[];
  readonly scopes?: readonly Scope[];
  readonly createdAtAfter?: Timestamp;
  readonly createdAtBefore?: Timestamp;
  readonly confirmedAfter?: Timestamp;
  readonly confirmedBefore?: Timestamp;
}

export interface VectorHit {
  readonly id: MemoryId;
  readonly cosine: number;
}

/**
 * Thrown when a row's stored embedding does not match the
 * configured provider's `model` or `dimension`. Surfaces
 * deterministically rather than silently mixing vector spaces.
 *
 * The pipeline maps this to a `CONFIG_ERROR` so the surface
 * (CLI / MCP) gets a structured "run `embedding rebuild`"
 * message rather than a stack trace.
 */
export class StaleEmbeddingError extends Error {
  readonly memoryId: string;
  readonly storedModel: string;
  readonly storedDimension: number;
  readonly providerModel: string;
  readonly providerDimension: number;

  constructor(args: {
    memoryId: string;
    storedModel: string;
    storedDimension: number;
    providerModel: string;
    providerDimension: number;
  }) {
    super(
      `memory ${args.memoryId} was embedded with model='${args.storedModel}' dimension=${args.storedDimension} but the configured provider is model='${args.providerModel}' dimension=${args.providerDimension}; run \`memento embedding rebuild\` to migrate stored vectors`,
    );
    this.name = 'StaleEmbeddingError';
    this.memoryId = args.memoryId;
    this.storedModel = args.storedModel;
    this.storedDimension = args.storedDimension;
    this.providerModel = args.providerModel;
    this.providerDimension = args.providerDimension;
  }
}

/**
 * Run a brute-force cosine-similarity scan and return at most
 * `limit` hits ordered by similarity descending (most-similar
 * first).
 *
 * Rows with `embedding_json IS NULL` (never embedded) are
 * skipped silently — they simply don't contribute vector
 * candidates. Rows with a *mismatching* `model`/`dimension`
 * raise {@link StaleEmbeddingError}, since silently dropping
 * them would hide a real consistency problem.
 *
 * `queryVector.length` must equal `provider.dimension`; the
 * caller (the pipeline) embeds the query through the same
 * provider, so this is enforced upstream.
 */
export async function searchVector(
  db: Kysely<MementoSchema>,
  options: VectorSearchOptions,
): Promise<VectorHit[]> {
  if (options.statuses.length === 0) {
    return [];
  }
  if (options.kinds !== undefined && options.kinds.length === 0) {
    return [];
  }
  if (options.scopes !== undefined && options.scopes.length === 0) {
    return [];
  }
  if (options.queryVector.length !== options.provider.dimension) {
    throw new Error(
      `searchVector: queryVector length ${options.queryVector.length} does not match provider dimension ${options.provider.dimension}`,
    );
  }
  if (options.limit <= 0) {
    return [];
  }

  const statusList = sql.join(options.statuses.map((s) => sql.lit(s)));
  const kindClause =
    options.kinds === undefined
      ? sql``
      : sql` and kind_type in (${sql.join(options.kinds.map((k) => sql.lit(k)))})`;
  const scopeClause =
    options.scopes === undefined
      ? sql``
      : sql` and (${sql.join(
          options.scopes.map(
            (scope) => sql`(scope_type = ${scope.type} and scope_json = ${JSON.stringify(scope)})`,
          ),
          sql` or `,
        )})`;

  // Half-open temporal windows. Mirrors the FTS arm so vector
  // candidates respect the same date filter the caller asked for.
  const createdAfterClause =
    options.createdAtAfter === undefined
      ? sql``
      : sql` and created_at >= ${options.createdAtAfter as unknown as string}`;
  const createdBeforeClause =
    options.createdAtBefore === undefined
      ? sql``
      : sql` and created_at < ${options.createdAtBefore as unknown as string}`;
  const confirmedAfterClause =
    options.confirmedAfter === undefined
      ? sql``
      : sql` and last_confirmed_at >= ${options.confirmedAfter as unknown as string}`;
  const confirmedBeforeClause =
    options.confirmedBefore === undefined
      ? sql``
      : sql` and last_confirmed_at < ${options.confirmedBefore as unknown as string}`;

  // Pull only the columns the scanner needs. The embedding
  // payload is the dominant byte-cost; everything else is small.
  const rows = await sql<{ id: string; embedding_json: string }>`
    select id, embedding_json
    from memories
    where embedding_json is not null
      and status in (${statusList})${kindClause}${scopeClause}${createdAfterClause}${createdBeforeClause}${confirmedAfterClause}${confirmedBeforeClause}
  `.execute(db);

  const queryNorm = l2Norm(options.queryVector);
  if (queryNorm === 0) {
    // A zero-vector query has no defined cosine similarity;
    // cosine-against-anything is 0/0. Return no candidates
    // rather than emitting NaN scores into the ranker.
    return [];
  }

  const hits: VectorHit[] = [];
  for (const row of rows.rows) {
    // Repository writes `EmbeddingSchema.parse(...)` then
    // `JSON.stringify`s, so the persisted shape is trustworthy
    // — but we re-parse here rather than `JSON.parse` raw to
    // keep the dimension/model invariants enforced at every
    // read boundary (defence in depth).
    const parsed = EmbeddingSchema.parse(JSON.parse(row.embedding_json));
    if (
      parsed.model !== options.provider.model ||
      parsed.dimension !== options.provider.dimension
    ) {
      throw new StaleEmbeddingError({
        memoryId: row.id,
        storedModel: parsed.model,
        storedDimension: parsed.dimension,
        providerModel: options.provider.model,
        providerDimension: options.provider.dimension,
      });
    }
    const cosine = cosineSimilarity(options.queryVector, parsed.vector, queryNorm);
    hits.push({ id: row.id as MemoryId, cosine });
  }

  // Partial sort would be marginally faster, but for the v1
  // default (`vectorLimit = 200`, eligible rows in the low
  // thousands) the full sort is sub-millisecond and easier to
  // reason about. Revisit if profiling shows it dominates.
  hits.sort((a, b) => b.cosine - a.cosine);
  return hits.slice(0, options.limit);
}

/**
 * Compute cosine similarity between two equal-length vectors.
 * Exported for unit tests and for the pipeline's own probes;
 * the brute-force scanner is the only production caller.
 *
 * `aNorm` is accepted as a parameter so the scanner can compute
 * the query-vector norm once and reuse it for every row.
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
  aNorm?: number,
): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let bSquared = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    bSquared += bv * bv;
  }
  const aN = aNorm ?? Math.sqrt(squaredNorm(a));
  const bN = Math.sqrt(bSquared);
  if (aN === 0 || bN === 0) {
    return 0;
  }
  return dot / (aN * bN);
}

function l2Norm(v: readonly number[]): number {
  return Math.sqrt(squaredNorm(v));
}

function squaredNorm(v: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] as number;
    s += x * x;
  }
  return s;
}

// Re-export `Embedding` for convenience so the pipeline doesn't
// need to import from two places.
export type { Embedding };
