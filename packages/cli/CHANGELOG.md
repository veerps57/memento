# @psraghuveer/memento

## 0.3.2

### Patch Changes

- a9826e1: Add the Memento skill bundle and surface it from `memento init`.

  The new bundle (`skills/memento/SKILL.md`) teaches Anthropic-skill-capable
  clients — Claude Code, Claude Desktop, Cowork — when to call the Memento
  MCP tools (`write_memory`, `extract_memory`, `get_memory_context`,
  `confirm_memory`, `supersede_memory`, `forget_memory`, …), how to choose
  scope and kind, when to supersede instead of update, and how to handle
  conflicts and sensitive content. Closes the adoption gap from ADR-0016
  without requiring users to hand-paste a persona snippet. Clients that do
  not load Anthropic skills (Cursor, VS Code Agent, OpenCode) continue to
  use the persona-snippet alternative in
  `docs/guides/teach-your-assistant.md`.

  `memento init` now ships an "── Memento skill (optional) ──" section
  gated on the rendered client set: shown when at least one
  skill-capable client is present, suppressed otherwise. The skill
  source is staged into the npm tarball by a build-time
  `copy-skills.mjs` script so `npx`-only users get a real absolute
  path to copy from. `init` is still print-only by design — the
  section lists a `cp -R …` command rather than mutating the user's
  skills directory.

  The `InitSnapshot` contract grows one new field, `skill: SkillInstallInfo`
  — additive — and `ClientSnippet` grows `supportsSkills: boolean`. No
  existing fields change shape.

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
