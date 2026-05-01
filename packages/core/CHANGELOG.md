# @psraghuveer/memento-core

## 0.2.0

### Minor Changes

- b64dd5d: Improve MCP usability for AI assistants

  - Flatten `conflict.scan` input schema from discriminated union to flat object with refinements, fixing empty-schema rendering in MCP clients (e.g. Claude Desktop)
  - Add `tags` filter to `memory.list` and `memory.search` (AND logic, normalised to lowercase)
  - Add migration 0005: rebuild FTS5 index with `tags` column so tags are text-searchable
  - Add `memory.confirm_many` command for batch re-affirmation of multiple memories
  - Add `includeEmbedding` option to `memory.list` and `memory.search` (defaults to false, stripping large vectors from output)
  - Add `system.list_tags` command for discovering tags in use, sorted by frequency

## 0.1.1

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
