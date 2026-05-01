# @psraghuveer/memento

## 0.3.1

### Patch Changes

- Updated dependencies [d1b6aaf]
  - @psraghuveer/memento-schema@0.4.0
  - @psraghuveer/memento-core@0.5.0
  - @psraghuveer/memento-embedder-local@0.3.0
  - @psraghuveer/memento-server@0.2.1

## 0.3.0

### Minor Changes

- 544e96b: Add memory.context and memory.extract commands (ADR-0016)

  - `memory.extract`: batch extraction with embedding-based dedup (skip/supersede/write) and configurable confidence defaults
  - `memory.context`: query-less ranked retrieval for session-start context injection
  - ~13 new config keys for extraction thresholds, context limits, and ranking weights
  - Remove dead code (`commands/memory/errors.ts`)
  - Harden test coverage across bulk commands, retrieval pipeline, CLI lifecycle, and doc renderers

### Patch Changes

- Updated dependencies [544e96b]
  - @psraghuveer/memento-core@0.4.0
  - @psraghuveer/memento-schema@0.3.0
  - @psraghuveer/memento-server@0.2.0
  - @psraghuveer/memento-embedder-local@0.2.1

## 0.2.1

### Patch Changes

- f099020: Fix embedder resolution failure in global npm installs by removing the `createRequire` gate that silently returned `undefined` when the package was actually present.

## 0.2.0

### Minor Changes

- 1fdbf05: Embeddings default-on: flip `retrieval.vector.enabled` to `true`, add `embedding.autoEmbed` config key for fire-and-forget embedding on write, upgrade default model to `bge-base-en-v1.5` (768d), move `@psraghuveer/memento-embedder-local` to a regular dependency, and make the search pipeline degrade gracefully to FTS-only on transient embed failures.

### Patch Changes

- Updated dependencies [1fdbf05]
  - @psraghuveer/memento-core@0.3.0
  - @psraghuveer/memento-schema@0.2.0
  - @psraghuveer/memento-embedder-local@0.2.0
  - @psraghuveer/memento-server@0.1.3

## 0.1.3

### Patch Changes

- Updated dependencies [b64dd5d]
  - @psraghuveer/memento-core@0.2.0
  - @psraghuveer/memento-embedder-local@0.1.1
  - @psraghuveer/memento-server@0.1.2

## 0.1.2

### Patch Changes

- 3957548: Improve MCP tool usability for AI agents

  - Add `.describe()` annotations to all Zod input schemas with examples and format hints
  - Inject OpenAPI 3.1 discriminator hints into JSON Schema output for discriminated unions
  - Include Zod issue summary in INVALID_INPUT error messages for self-correction
  - Default `owner` to `{"type":"local","id":"self"}`, `summary` to `null`, `pinned` and `storedConfidence` to config-driven values (`write.defaultPinned`, `write.defaultConfidence`)
  - Add usage examples to command descriptions
  - Enhance tool discoverability: scope hints, confirm gate guidance, workflow notes

- Updated dependencies [3957548]
  - @psraghuveer/memento-schema@0.1.1
  - @psraghuveer/memento-core@0.1.1
  - @psraghuveer/memento-server@0.1.1

## 0.1.1

### Patch Changes

- c6e2d95: Fix `memento init` failing on fresh hosts where the platform data directory (e.g. `~/.local/share/memento/` or `%LOCALAPPDATA%\memento\`) did not yet exist. `init` now creates the parent directory recursively before the writability check, so the first run on a brand-new laptop succeeds.
