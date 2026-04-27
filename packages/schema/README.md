# @psraghuveer/memento-schema

Zod schemas and TypeScript types shared across every Memento package.

This package is the single source of truth for:

- The `Memory` entity and its `MemoryKind` discriminated union (`fact` | `preference` | `decision` | `todo` | `snippet`)
- `MemoryEvent`, `ScrubReport`, `Conflict`, `ConflictEvent`, `ConfigEntry`, `ConfigEvent`
- `OwnerRef`, `ActorRef`, `Scope`
- `ConfigKey` / `ConfigSource` and the per-key value schemas
- The universal `Result<T>` envelope and the `ErrorCode` enum

Every other package in the workspace consumes these types — see ADR [0002 — Single typed config schema as source of truth](../../docs/adr/0002-zod-config-schema.md).
