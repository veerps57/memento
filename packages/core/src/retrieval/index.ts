// Retrieval surface — see `docs/architecture/retrieval.md` for
// the pipeline overview and the per-stage rationale.

export type {
  SearchQuery,
  SearchResult,
  SearchPage,
  ScoreBreakdown,
  RawCandidate,
} from './types.js';
export { sanitizeFtsQuery, searchFts } from './fts.js';
export type { FtsHit, FtsSearchOptions } from './fts.js';
export { rankLinear } from './ranker.js';
export type { RankerOptions, RankerWeights } from './ranker.js';
export { searchMemories, VectorRetrievalConfigError } from './pipeline.js';
export type { SearchDeps } from './pipeline.js';
export { searchVector, cosineSimilarity, StaleEmbeddingError } from './vector.js';
export type { VectorHit, VectorSearchOptions } from './vector.js';
