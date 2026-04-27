// Minimal type shim for `@huggingface/transformers`.
//
// Why a shim and not a real dependency?
//
// `@psraghuveer/memento-embedder-local` is a thin adapter. The transformers.js
// runtime is large (~100 MB once the model is cached) and is only
// needed when a consumer opts in to vector retrieval (off by
// default — see ADR 0006 and `docs/architecture/retrieval.md`).
// Listing it in `dependencies` would force every Memento install
// to pay that cost; listing it as an `optionalPeerDependency`
// still triggers `auto-install-peers=true` in this workspace.
//
// Instead we ship this shim so the source typechecks against a
// minimal contract, and the runtime resolves the real package
// only at the point of first use. If the consumer hasn't
// installed `@huggingface/transformers`, the dynamic `import()`
// throws and `createLocalEmbedder` propagates a friendly error.
//
// Keep this declaration minimal: only the surface this package
// actually touches. Extending it later is fine; mirroring the
// upstream type definitions is not the goal.

declare module '@huggingface/transformers' {
  export interface FeatureExtractionOptions {
    readonly pooling?: 'mean' | 'cls' | 'none';
    readonly normalize?: boolean;
  }

  export interface FeatureExtractionTensor {
    readonly data: Float32Array | Float64Array;
    readonly dims: readonly number[];
  }

  export type FeatureExtractionPipeline = (
    text: string,
    options?: FeatureExtractionOptions,
  ) => Promise<FeatureExtractionTensor>;

  export function pipeline(
    task: 'feature-extraction',
    model: string,
  ): Promise<FeatureExtractionPipeline>;

  export const env: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
}
