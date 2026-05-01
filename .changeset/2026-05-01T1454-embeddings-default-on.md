---
"@psraghuveer/memento": minor
"@psraghuveer/memento-core": minor
"@psraghuveer/memento-schema": minor
"@psraghuveer/memento-embedder-local": minor
---

Embeddings default-on: flip `retrieval.vector.enabled` to `true`, add `embedding.autoEmbed` config key for fire-and-forget embedding on write, upgrade default model to `bge-base-en-v1.5` (768d), move `@psraghuveer/memento-embedder-local` to a regular dependency, and make the search pipeline degrade gracefully to FTS-only on transient embed failures.
