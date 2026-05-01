---
"@psraghuveer/memento-core": minor
"@psraghuveer/memento-schema": minor
"@psraghuveer/memento-server": minor
"@psraghuveer/memento": minor
---

Add memory.context and memory.extract commands (ADR-0016)

- `memory.extract`: batch extraction with embedding-based dedup (skip/supersede/write) and configurable confidence defaults
- `memory.context`: query-less ranked retrieval for session-start context injection
- ~13 new config keys for extraction thresholds, context limits, and ranking weights
- Remove dead code (`commands/memory/errors.ts`)
- Harden test coverage across bulk commands, retrieval pipeline, CLI lifecycle, and doc renderers
