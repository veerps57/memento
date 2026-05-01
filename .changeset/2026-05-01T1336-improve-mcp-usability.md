---
'@psraghuveer/memento-core': minor
---

Improve MCP usability for AI assistants

- Flatten `conflict.scan` input schema from discriminated union to flat object with refinements, fixing empty-schema rendering in MCP clients (e.g. Claude Desktop)
- Add `tags` filter to `memory.list` and `memory.search` (AND logic, normalised to lowercase)
- Add migration 0005: rebuild FTS5 index with `tags` column so tags are text-searchable
- Add `memory.confirm_many` command for batch re-affirmation of multiple memories
- Add `includeEmbedding` option to `memory.list` and `memory.search` (defaults to false, stripping large vectors from output)
- Add `system.list_tags` command for discovering tags in use, sorted by frequency
