# Architecture: Configuration

This document describes Memento's configuration surface — its shape, validation, layering, and lifecycle.

The principle: **behavior is shaped by configuration, not by code.** Every magic number is a `ConfigKey`. Adding a hardcoded constant for a behavioral concern is a code-review rejection.

## The shape

Configuration is a single typed schema (`@psraghuveer/memento-schema/config-keys`). Each key is registered with `defineKey(name, valueSchema, { default, mutable })` so the Zod schema, the TypeScript type, the default, and the immutability flag are co-located in one place. There is no separate type definition to drift.

The complete, authoritative list — every registered key with its current default, value schema, immutability flag, and one-line description — is auto-generated from the registry into [`docs/reference/config-keys.md`](../reference/config-keys.md) on every `pnpm docs:generate` and verified in `pnpm verify`. Keys are grouped by dotted namespace:

- **`retrieval.*`** — FTS tokenizer, vector backend, ranker strategy and per-signal weights, candidate / search limits, recency half-life, scope boost.
- **`decay.*`** — per-kind half-life (`fact`, `preference`, `decision`, `todo`, `snippet`), pinned floor, archive threshold, archive-after window.
- **`conflict.*`** — master enable, per-write timeout, scope strategy, search surfacing, open-pressure warning threshold, list limits, and the per-kind detector tunables that exist (`conflict.fact.overlapThreshold`).
- **`extraction.*`** and **`context.*`** — async-extraction processing mode and dedup thresholds; query-less context-injection ranker tunables.
- **`embedder.*`** and **`embedding.*`** — local model id and dimension (immutable), input-byte cap, wallclock timeout, cache directory; auto-embed on write; bounded startup backfill.
- **`packs.*`** — bundled-registry path (immutable), URL-fetch policy, size cap, timeout, max memories per pack.
- **`scrubber.*`** — engine enable / rule list (both immutable, pinned at server start), per-rule budget.
- **`safety.*`** — bulk-operation and resource-cap defaults.
- **`server.*`** — stdio message size cap (immutable).
- **`storage.*`** — SQLite busy timeout.
- **`privacy.*`**, **`user.*`**, **`write.*`**, **`import.*`**, **`export.*`**, **`memory.*`**, **`events.*`**, **`compact.*`** — single-key namespaces for read-path redaction, the user's preferred display name, write-time defaults, import / export limits, list pagination, and compaction batch size.
- **`plugin.*`** — reserved namespace, currently inert.

For an exact value, default, mutability flag, or the rationale for any specific key, read the generated reference. This document keeps the prose; the reference keeps the table.

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

Some keys are immutable after server start. The schema marks these (`mutable: false`); attempts to mutate them at runtime return an `IMMUTABLE` error. The current set is enumerated in [`docs/reference/config-keys.md`](../reference/config-keys.md) — broadly: `storage.busyTimeoutMs`; the FTS tokenizer and vector backend; the local embedder's model, dimension, byte cap, timeout, and cache directory; the stdio message-size cap; the scrubber's enable flag and rule list; the bundled-pack registry path; and the startup-backfill knobs.

Two clusters worth calling out for the reasoning:

- **`scrubber.enabled` and `scrubber.rules`** are pinned at server start so a prompt-injected MCP `config.set` cannot disable redaction or weaken the rule set before writing a secret. See ADR-0019 for the related "imports never trust caller-supplied audit claims" stance.
- **`embedder.local.model` and `embedder.local.dimension`** are immutable so the stored vector space cannot drift mid-session — switching models is an explicit `embedding.rebuild` operation (Rule 14). Operators that need a different model pass it via `configOverrides` to `createMementoApp` (library use); `config.set` will reject the change at runtime.

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
