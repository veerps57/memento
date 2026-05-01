# ADR-0006: Local embeddings only

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** embeddings, retrieval, dependencies

## Context

Vector search benefits from embeddings. Embedding options:

- **Local model via transformers.js** (`bge-base-en-v1.5`): no network calls, model downloaded on first use, ~110 MB, runs on CPU.
- **Cloud embedders** (OpenAI, Cohere, Voyage): higher quality, requires network and API keys, sends content to a third party.
- **No embeddings**: ship FTS only.

Memento's positioning is local-first, with privacy as a load-bearing property. Sending memory content to a remote embedder defeats this for the mainstream user.

## Decision

Ship `@psraghuveer/memento-embedder-local` (transformers.js + `bge-base-en-v1.5`) as the only embedding option and a regular dependency of the CLI package. Vector search is **on by default** (`retrieval.vector.enabled = true`); users can opt out. Cloud embedders are deliberately out of scope.

The embedder is exposed behind an `EmbeddingProvider` interface. Adding cloud providers later is a new package, not a refactor.

## Consequences

### Positive

- Privacy preserved by default.
- No API keys to manage.
- Works offline after first model download.

### Negative

- First-use latency to download the model (~110 MB, one time). Search degrades gracefully to FTS-only until the download completes.
- Local model quality is below frontier cloud models. Acceptable; FTS picks up the slack on lexical queries, and `bge-base-en-v1.5` is a strong local model.
- CPU embedding cost for large memory bases. Acceptable at the scales Memento targets.

### Risks

- Users expect cloud-quality recall. Mitigation: documented honestly in `KNOWN_LIMITATIONS.md`; FTS catches most lexical needs.

## Alternatives considered

### Cloud embedder support

Attractive: better recall. Rejected: contradicts the local-first positioning; adds key management, billing, and a network dependency that the rest of the system avoids.

### No embeddings

Attractive: simpler. Rejected: FTS misses paraphrases; the "smart memory" promise weakens. Local embeddings get most of the benefit for almost none of the cost.

## Validation against the four principles

1. **First principles.** Local-first is non-negotiable; the embedder must respect it.
2. **Modular.** `EmbeddingProvider` interface; the provider is replaceable.
3. **Extensible.** Cloud providers are additive; no breaking changes required.
4. **Config-driven.** Vector search is on by default but configurable; the model is configurable; the backend is configurable.

## References

- [docs/architecture/retrieval.md](../architecture/retrieval.md)
- ADR-0001 (SQLite + sqlite-vec)
