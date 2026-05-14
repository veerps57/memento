// @psraghuveer/memento-embedder-local — local-only EmbeddingProvider.
//
// Implements the EmbeddingProvider interface from @psraghuveer/memento-core
// using transformers.js with the bge-small-en-v1.5 model.
// Lazy-loaded: importing this module does not download or
// initialise the runtime; the first embed() call does.
//
// This is the only embedder shipped in v1 (per ADR 0006).

export {
  createLocalEmbedder,
  createDefaultLoader,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_DIMENSION,
} from './embedder.js';

export type {
  EmbedBatchFn,
  EmbedFn,
  EmbedRuntime,
  LocalEmbedderLoader,
  LocalEmbedderLoaderContext,
  LocalEmbedderOptions,
} from './embedder.js';
