# Architecture: Configuration

This document describes Memento's configuration surface — its shape, validation, layering, and lifecycle.

The principle: **behavior is shaped by configuration, not by code.** Every magic number is a `ConfigKey`. Adding a hardcoded constant for a behavioral concern is a code-review rejection.

## The shape

Configuration is a single typed schema (`@psraghuveer/memento-schema/config`). It is a Zod schema; the TypeScript type is derived via `z.infer`. There is no separate type definition to drift.

```ts
type ConfigKey =
  // — Server —
  | "server.transport" // 'stdio'
  | "server.logLevel" // 'trace' | 'debug' | 'info' | 'warn' | 'error'

  // — Storage —
  | "storage.path" // override default DB path
  | "storage.busyTimeoutMs"

  // — Scope —
  | "scope.defaultWriteScope" // 'global' | 'workspace' | 'repo' | 'branch' | 'session'
  | "scope.defaultReadFilter" // 'all' | 'effective' | <list>
  | "scope.layerBoosts.<scope>" // per-scope boost when layering

  // — Retrieval —
  | "retrieval.fts.tokenizer"
  | "retrieval.fts.bm25.k1"
  | "retrieval.fts.bm25.b"
  | "retrieval.vector.enabled"
  | "retrieval.vector.backend" // 'sqlite-vec' | 'brute-force' | 'auto'
  | "retrieval.ranker.strategy" // 'linear' | 'reciprocal-rank-fusion' | 'custom'
  | "retrieval.ranker.weights.fts"
  | "retrieval.ranker.weights.vector"
  | "retrieval.ranker.weights.confidence"
  | "retrieval.ranker.weights.recency"
  | "retrieval.ranker.weights.scope"
  | "retrieval.ranker.weights.pinned"
  | "retrieval.recency.halfLife"

  // — Decay —
  | "decay.halfLife.fact"
  | "decay.halfLife.preference"
  | "decay.halfLife.decision"
  | "decay.halfLife.todo"
  | "decay.halfLife.snippet"
  | "decay.pinnedFloor"
  | "decay.archiveThreshold"
  | "decay.archiveAfter"

  // — Conflict —
  | "conflict.enabled"
  | "conflict.timeoutMs"
  | "conflict.scopeStrategy" // 'same' | 'effective'
  | "conflict.surfaceInSearch"
  | "conflict.maxOpenBeforeWarning"
  | "conflict.<kind>.*" // per-kind tuning

  // — Embedding —
  | "embedding.autoEmbed" // default true; fire-and-forget embed on write
  // — Embedder —
  | "embedder.local.model" // default 'bge-base-en-v1.5', resolved as `Xenova/<model>`
  | "embedder.local.dimension" // default 768; must match the chosen model

  // — Scrubber —
  | "scrubber.enabled"
  | "scrubber.rules" // ordered list of rule objects
  | "scrubber.placeholderFormat" // template string

  // — Reserved —
  | "plugin.*"; // reserved namespace, currently inert
```

The full list with types and defaults is generated into [`docs/reference/config-keys.md`](../reference/config-keys.md).

## Layering

Configuration is resolved from two layers, lowest precedence first:

1. **Built-in defaults.** Compiled into `@psraghuveer/memento-schema/config`.
2. **MCP runtime config.** `config.set` calls during a server session. The CLI also surfaces `config.set` / `config.unset` and writes `ConfigEvent`s to the same audit log; events from CLI calls record `source: 'cli'`, events from MCP calls record `source: 'mcp'`.

Higher precedence wins per-key. Operators that need startup-time overrides pass them programmatically as `configOverrides` to `createMementoApp`; these are recorded in the runtime view as `source: 'cli'`.

## Validation

Every layer is validated against the Zod schema before merging. Invalid configs cause:

- **At server start:** the server fails fast with a structured error pointing at the first invalid key.
- **At runtime via `config.set`:** the call returns an error and the value is not applied.

There is no permissive mode. Invalid config silently producing wrong behavior is exactly the failure mode the schema exists to prevent.

## Mutation

Configuration is mutable at runtime via:

- `config.set <key> <value>` (CLI and MCP).
- `config.unset <key>` (CLI and MCP) — reverts the key to the next-lower layer.

Every mutation writes a `ConfigEvent` with `{ key, oldValue, newValue, source, actor, at }`. Configuration history is queryable: `memento config history --key=<key>`.

Some keys are immutable after server start — e.g. `storage.busyTimeoutMs`, `retrieval.fts.tokenizer`, `retrieval.vector.backend`. The schema marks these (`mutable: false`); attempts to mutate them at runtime return an `IMMUTABLE` error. The set is small and pinned in the reference docs.

## Defaults

Defaults are chosen to produce sensible behavior on first use without ceremony. They are conservative — biased toward correctness over performance, and toward visibility over silence. They are documented in [`docs/reference/config-keys.md`](../reference/config-keys.md) so changes are visible in PR diffs.

A change to a default is treated as a behavioral change and requires an ADR if the key is load-bearing.

## Reserved namespaces

`plugin.*` is reserved. Setting a key under this namespace does not produce an error but does not affect behavior. This keeps user configs forward-compatible if a plugin surface is ever introduced.

## What this enables

- **Tuning without forking.** Every behavior knob is exposed.
- **Audit of behavioral drift.** "When did our ranker weights change?" is a query.
- **Per-workspace customization.** A monorepo can pin different behavior than a personal scratch repo.

## What this deliberately omits

- **Profiles.** A single workspace has a single config.
- **Remote config.** Configuration is local.
- **Config files / environment variables / CLI flags.** Built-in defaults plus runtime mutation via `config.set` cover the supported surface; programmatic `configOverrides` are available to embedding hosts.
- **Schema migrations for config.** New keys ship with safe defaults.
