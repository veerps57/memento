# Reference

This directory contains user-facing reference documentation. Most files here are **generated** from source-of-truth definitions in code: do not edit them by hand.

## Files

| File                               | Generated from                      |
| ---------------------------------- | ----------------------------------- |
| [`mcp-tools.md`](mcp-tools.md)     | `@psraghuveer/memento-core/commands` registry   |
| [`cli.md`](cli.md)                 | `@psraghuveer/memento-core/commands` registry   |
| [`config-keys.md`](config-keys.md) | `@psraghuveer/memento-schema/config` Zod schema |
| [`error-codes.md`](error-codes.md) | `@psraghuveer/memento-core/errors`              |

To regenerate, run:

```bash
pnpm docs:generate
```

CI verifies that the generated docs are up to date via `pnpm docs:check`.

## Why generated

Reference docs that drift from code mislead users. Generation makes drift impossible: the docs can only describe what the code actually exposes. Hand-written context and walkthroughs live in [`../architecture/`](../architecture/) and [`../adr/`](../adr/) where prose is the right shape.

## What the first generator emits

The current generator covers each file's high-value structural information:

- **Names** (every command, key, and code is listed exactly once).
- **Descriptions** (one-line `description` plus optional `longDescription`).
- **Side-effect class** for commands (`read` / `write` / `destructive` / `admin`).
- **MCP annotation hints** when a command overrides them.
- **Default values and mutability** for every config key.

Input and output Zod schemas are not yet projected into Markdown — readers should consult the source until a faithful schema renderer ships. The schemas themselves are validated on every call by the adapter, so the runtime contract is unchanged.
