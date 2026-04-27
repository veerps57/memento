# ADR-0011: Assistant-callable system commands

- **Status:** Accepted
- **Date:** 2025-01-29
- **Deciders:** core
- **Tags:** mcp, cli, observability, registry

## Context

The Memento command registry exposes 23 tools across the MCP and
CLI surfaces. None of them lets an MCP-connected coding assistant
answer two recurring questions:

1. *"Is this server alive, and what does it know how to do?"*
   The assistant has no in-protocol way to discover the binary's
   version, its database location, whether vector retrieval is
   wired, or how many memories the store holds. The closest
   thing is `memento doctor`, but that is a CLI-only command and
   it does host-level probes (peer-package resolution, lock
   files, free disk space) the registry layer should not know
   about.

2. *"Which scopes does this user have anything in?"*
   Before issuing a scoped read, an assistant has to either guess
   plausible scopes or call `memory.list` with no filter and
   post-process the result. The first guesses wrong; the second
   defeats the point of scoping.

Both gaps surfaced in the user-story audit (groups A4 and G1).
Both are pure read-only introspection: every fact that answers
them is already inside the open `MementoApp` (config store,
memory repository, schema constants, embedder presence flag). No
new subsystem is needed — only a registered command set.

A precedent already exists for splitting an introspection probe
across two surfaces: `memento context` and `memento doctor` both
serve the operator. They cannot be promoted to MCP as-is because
they perform filesystem checks and IO that an assistant should
not see (and that the registry contract forbids). The right move
is a *third* probe, narrower than either, that runs on the
already-open app.

## Decision

Introduce a `system.*` command set with two members, registered
unconditionally on every `MementoApp` and exposed on both `mcp`
and `cli` surfaces:

- **`system.info`** — `sideEffect: 'read'`. Returns
  `{ version, schemaVersion, dbPath, vectorEnabled, embedder:{ configured, model, dimension }, counts:{ active, archived, forgotten, superseded } }`.
  Every field reflects in-app state at call time: the config
  store is read live (so flipping `retrieval.vector.enabled`
  shows up immediately), the counts come from a single
  `SELECT status, COUNT(*) GROUP BY status` over the `memories`
  table, the embedder flag reflects whether the host wired an
  `EmbeddingProvider`, and `version`/`dbPath` are threaded
  through from the bootstrap caller.

- **`system.list_scopes`** — `sideEffect: 'read'`. Returns
  `{ scopes: Array<{ scope, count, lastWriteAt }> }` sorted by
  `count` desc then `lastWriteAt` desc. Only `status='active'`
  rows are counted; scopes whose only memories are archived,
  forgotten, or superseded do not appear.

Both commands have empty strict input schemas (`z.object({}).strict()`)
so an MCP client can call them with no arguments while still
rejecting unknown fields.

The bootstrap accepts a new optional `appVersion?: string` on
`CreateMementoAppOptions`, defaulting to `'unknown'`. CLI and
server hosts pass their package version through to it.
`MEMORY_SCHEMA_VERSION` is threaded as a dependency rather than
imported by the command file directly, keeping a future split
between memory and event schema versions an additive change.

## Consequences

### Positive

- An MCP-connected assistant can probe the server's capability
  matrix in one round trip without leaving the protocol.
- Scope discovery becomes a first-class operation instead of a
  list-and-filter dance.
- The CLI inherits both probes automatically (no extra
  lifecycle command), so operators can `memento system info`
  for fast diagnostics.
- Threading `appVersion` through the bootstrap keeps the
  composition root the only place that sees host-level
  metadata, preserving Rule 1 (single registry).

### Negative

- One extra `SELECT ... GROUP BY` per `system.info` call. Both
  the `memories(status)` and the canonical scope grouping are
  fast on stores in the practical size range; cost is
  negligible relative to a memory write.
- Adds two commands to the public registry contract. They are
  the first registered `system.*` commands, so the namespace is
  permanently claimed.

### Risks

- `system.info` revealing `dbPath` could leak filesystem
  structure to an LLM that writes it back into a chat log. The
  field is treated as a diagnostic hint, not a secret; future
  hardening can redact it behind a config flag if a deployment
  needs to.
- `version` is host-supplied and could drift from the actual
  binary if a host wires it incorrectly. Marked `'unknown'`
  fallback rather than a contract.

## Alternatives considered

### Alternative A: Promote `memento doctor` to MCP

Attractive because the command already exists and answers most
of these questions. Rejected because `doctor` performs
filesystem probes (peer-package resolution, lock files, free
disk space) that the registry contract forbids: every registered
command must run purely against the injected app dependencies.
Splitting `doctor`'s in-app slice into `system.info` keeps the
contract clean.

### Alternative B: Inline annotations on every command

Each MCP tool already has a `description`. We could pack the
server's version and capability bits into a sentinel
description on a marker command, or emit them as MCP server
metadata. Rejected because:

- MCP server metadata is set once at handshake and cannot
  reflect live config changes (e.g., `retrieval.vector.enabled`
  flipped via `config.set`).
- An assistant that wants the data has to remember to look at
  the handshake — there is no protocol-level "ask again".
- Sentinel descriptions are not discoverable.

A first-class command is *the* discoverable shape for live
state.

### Alternative C: Filesystem checks inside `system.info`

Tempting to fold "is the database file writable" or "does
`@memento/embedder-local` resolve" into `system.info` so the
assistant gets a single answer. Rejected because:

- It mixes the registry layer with host-level probes.
- It would force every registered command to run the same
  checks on every call (per Rule 1, registered commands do not
  conditionally bypass policy by name).
- `memento doctor` exists for exactly this purpose, and its
  human-targeted output is more useful than a JSON probe an
  assistant has to parse.

## Validation against the four principles

1. **First principles.** An MCP assistant should be able to ask
   the server what it is and what it knows. Filesystem checks
   are a different concern (operator triage). The two should
   not be the same command.
2. **Modular.** `createSystemCommands` is a standalone factory
   that takes typed dependencies. Hosts can swap or wrap it the
   same way they would any other command set.
3. **Extensible.** Both output schemas are open-shaped: every
   nested object can grow new fields without breaking existing
   clients (clients pattern-match on `version` /
   `schemaVersion`, never deep-equality). Future probes
   (`system.list_actors`, `system.last_event`) join the same
   namespace.
4. **Config-driven.** No new config keys. Behaviours that *do*
   need configuration (e.g., redaction of `dbPath`) will get
   their own `ConfigKey` when the requirement appears, per
   Rule 2.

## References

- ADR-0003 (single command registry).
- ADR-0010 (MCP tool naming).
- User-story audit gaps **A4** (cheap version probe) and **G1**
  (assistant-callable doctor).
