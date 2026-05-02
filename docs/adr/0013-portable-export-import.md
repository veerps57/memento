# ADR-0013: Portable export/import — JSONL artefact for machine migration and exit

- **Status:** Accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Tags:** lifecycle, portability, audit, schema

## Context

Two user stories sit on the same mechanism but answer different questions:

- **P1.4 — No vendor lock-in.** "I can produce a complete export of my memory in a format I can read myself, and a fresh install can re-import it without loss."
- **P1.15 — Pick up where I left off on a new machine.** "On a fresh install on a new machine, I can hand the system the artefact I produced on the old machine and resume work with the same memories, the same scopes, and the same audit history visible to me."

Today neither is satisfied. The store is a single SQLite file the user owns, but the documented exit path is "copy the .db file" — which is not self-describing, has no version handshake, and can silently fail across schema versions.

The forces in play:

- **The artefact must be self-describing.** A user opening the file in a text editor must be able to read what's in it without running Memento.
- **The artefact must be versioned.** Schema and format versions are separate axes — a newer Memento may understand an older schema, but must refuse an artefact whose format it does not understand.
- **The audit history must travel.** Memory rows alone are insufficient: P1.5 ("see and audit what was remembered") requires the `memory_events` log on the new machine to look the same as on the old.
- **No silent loss.** If an item cannot be imported (schema drift, duplicate id, scrubber rejection), the user sees a structured report, not a partially-populated database.
- **Re-running is safe.** Importing the same artefact twice must not duplicate memories or events; the second run is a no-op.
- **Embeddings are large and optional.** A typical bge-small-en-v1.5 embedding is ~3 KB per memory. Including them by default would 10× the artefact size; skipping them lets the new machine re-embed lazily.

## Decision

We add a portable artefact format **`memento-export/v1`** and two new lifecycle commands, `memento export` and `memento import`. The artefact is **JSON Lines** (one JSON value per line), opens with a header record, and contains every row needed to reconstruct the persona's memory layer on a fresh install.

### Artefact format — `memento-export/v1`

The file is UTF-8 JSONL. Every line is a JSON object with a `type` discriminator. Order of records matters only for the header (which must be line 1); after that, importers must accept any interleaving.

```jsonl
{"type":"header","format":"memento-export/v1","schemaVersion":4,"mementoVersion":"0.1.0","exportedAt":"2026-04-26T12:00:00.000Z","counts":{"memories":42,"events":117,"conflicts":3,"embeddings":0},"includeEmbeddings":false}
{"type":"memory","data":{ /* canonical Memory row */ }}
{"type":"memory_event","data":{ /* canonical MemoryEvent row */ }}
{"type":"conflict","data":{ /* canonical Conflict row */ }}
{"type":"conflict_event","data":{ /* canonical ConflictEvent row */ }}
{"type":"embedding","data":{"memoryId":"…","model":"…","dimension":384,"vector":[…]}}
{"type":"footer","sha256":"<hex digest of all preceding bytes>"}
```

The header carries:

- `format` — literal `"memento-export/v1"`. The format version is decoupled from `schemaVersion` so we can change the file shape (e.g. add a `config` record type) without bumping the data schema, and vice versa.
- `schemaVersion` — the `MEMORY_SCHEMA_VERSION` of the source store.
- `mementoVersion` — the `package.json` version of the exporting build. Diagnostic only; the importer does not gate on it.
- `exportedAt` — ISO-8601 timestamp.
- `counts` — exact counts the importer cross-checks against actually observed records.
- `includeEmbeddings` — whether `embedding` records are present. False by default; `--include-embeddings` flips it.

The footer carries a SHA-256 of every preceding byte (header + records, in file order, including their trailing `\n`). The importer recomputes the digest as it reads and refuses to commit if it disagrees. This is a **corruption detector**, not a tamper-evident seal — a determined adversary can recompute the digest, but a truncated download or a mid-write power loss is caught up front.

`memory`, `memory_event`, `conflict`, and `conflict_event` records carry the **canonical entity shape from `@psraghuveer/memento-schema`** under `data`, not the SQL row shape. The importer parses each `data` payload through the appropriate Zod schema; importing is therefore symmetric with writing through the repository.

### `memento export`

```text
memento export --out <path> [--include-embeddings] [--scope <selector>]
```

Streams the artefact to `<path>` (or stdout when `<path>` is `-`). One read transaction holds the snapshot, so the artefact is point-in-time consistent. Output:

- `memories` — every row regardless of `status`, including `forgotten`, `superseded`, and `archived`. Lifecycle is part of the story.
- `memory_events` — every event for every memory exported.
- `conflicts` and `conflict_events` — every row.
- `embeddings` — only if `--include-embeddings` was passed.

`--scope <selector>` accepts the same scope serialisation the registry already uses (e.g. `repo:git@github.com:psraghuveer/memento.git`) and filters the snapshot. The default is "every scope present in the store"; the README example will use `--scope` for partial backups.

Sensitive memories travel **with their content**. Export is the user's own data on the user's own machine; redacting their own export would defeat the point of P1.4. The header record states `counts.sensitive` so a user can decide whether to ship the artefact off-machine. The warning is delivered as a structured `Result.warnings` field, not a prompt — automation must work.

### `memento import`

```text
memento import --in <path> [--dry-run] [--on-conflict skip|abort]
```

The default mode is `--dry-run=false` (proceed) with `--on-conflict=skip` (existing rows are left untouched).

Behaviour:

1. Open the artefact, parse the header, validate `format` literal.
2. If `header.schemaVersion > MEMORY_SCHEMA_VERSION`, refuse with `CONFIG_ERROR` and a message naming both versions and the upgrade command. *Never* silently downgrade an artefact.
3. If `header.schemaVersion < MEMORY_SCHEMA_VERSION`, the importer parses each record through the **current** Zod schema; missing fields fall back to schema defaults (e.g. `sensitive: false` for v3 artefacts). Items that fail to parse become entries in the structured report, not a transaction abort.
4. Dry-run mode parses everything, reports what would happen, and touches no rows. Used for verification.
5. Real import opens **one transaction** and inserts every record in input order:
   - `memory` rows insert by their original `id`. Collision handling follows `--on-conflict`: `skip` leaves the existing row and reports `skipped:duplicate-id`; `abort` rolls back the whole transaction with a structured error.
   - `memory_event` rows insert with their original `id`. A duplicate `id` is reported and skipped (events are append-only by id; a duplicate id from an old export of the same data is benign).
   - Same rules for conflicts and conflict-events.
   - `embedding` records call `repository.setEmbedding` for the matching memory, which appends a `reembedded` audit event — except during import we suppress the audit event for embeddings (they came in with the data, not from a new computation).
6. The final `footer` record's digest is verified before commit. A digest mismatch rolls back.
7. Success returns a `MementoImportSnapshot` with: counts inserted / skipped / failed by record type, and the list of skipped/failed items with reasons.

### Why JSON Lines and not a single JSON document

- A single JSON document does not stream — the parser must materialise the full object before yielding anything. JSONL streams record by record, which matters for stores at the high end (10⁵ memories).
- JSONL is `git diff`-friendly. P1.4 explicitly mentions the user reading the file themselves; line-based diffs make that practical.
- Every record is independently parseable. Truncated artefacts fail at the boundary, not in the middle of a deeply nested structure.

### Why not Protobuf / SQLite dump / tarball

A protobuf would be smaller but unreadable without Memento. A raw SQLite dump is the current (un)answer and ties portability to a specific SQLite version's file format. A tarball-of-JSONs adds packing overhead with no upside over a single streamed JSONL.

## Consequences

### Positive

- P1.4 (no vendor lock-in) and P1.15 (machine migration) both close with one mechanism.
- The artefact is a documented contract. Future Memento versions can consume v1 artefacts as long as they bundle a v1 importer (which we promise to keep).
- The audit history travels — the same "when did this come into existence" answer holds on the new machine.
- Re-running import is safe, because every record carries an id and the importer dedupes by id.
- The format is human-inspectable. A user who suspects something went wrong can `head -20` the file and see exactly what's there.

### Negative

- A new lifecycle command pair, plus the JSONL writer/reader, plus a header/footer schema. About 600 lines of new code with tests.
- The header's `mementoVersion` ties the artefact to a specific build, but only diagnostically (we never gate on it). We must keep that promise.
- An exporter that includes embeddings produces a much larger file. The opt-in flag is a footgun for users who do not realise their artefact is now megabytes.

### Risks

- **Schema-version skew.** We say "newer importer reads older artefact." That promise is mechanical: every additive migration must populate defaults at the schema layer, not the SQL layer. We already do this for `sensitive` (default `false`); the rule is reaffirmed here.
- **Id collisions across machines.** A user importing an artefact from a *different* persona's store could collide on memory ids (ULIDs are collision-resistant but not collision-proof across populations). The `--on-conflict abort` mode plus the dry-run rehearsal address this: the user sees the duplicates before any row is touched.
- **Sensitive data leaking via export files.** The header's `counts.sensitive` plus a structured warning are the loudest reasonable signal short of refusing to write the file. Users who want sensitive content excluded can scrub their store first (`memory.forget` on the offending rows) and re-export.
- **Footer digest as security theatre.** It is a corruption check, not authenticity. The ADR text and the importer's documentation say so.

## Alternatives considered

### Alternative A: Raw SQLite file copy

The current de-facto answer. Rejected:

- Not self-describing.
- Couples the artefact to a SQLite version.
- Carries WAL/SHM files in inconsistent states.
- No selective scope export.

### Alternative B: One JSON document with arrays per record type

`{ memories: [...], events: [...], conflicts: [...] }`. Rejected: does not stream, allocates the full object in memory, and a corruption mid-document is harder to localise than a corruption mid-line.

### Alternative C: Encrypted artefact with a passphrase

Compelling for sensitive data, but pulls in a key-management story (KDF choice, salt persistence, future re-encryption). Rejected for v1; the artefact is a snapshot of files the user already controls. Encryption stays open as a future ADR.

### Alternative D: Streaming MCP `system.export` tool

Have the MCP server emit the artefact as a tool result. Rejected: MCP tool results are not streamed in practice (clients buffer the whole response), so this is worse than a file path. Lifecycle command is the right shape — it owns its IO.

### Alternative E: Re-derive embeddings on import always

Make `embedding` records illegal. Rejected: a user with a custom embedder (not the default model) loses irrecoverable work on import. The `--include-embeddings` opt-in respects user choice both ways.

## Validation against the four principles

1. **First principles.** Two user stories require the same artefact, so we ship the artefact. The artefact is the smallest bundle that can answer "reconstruct my memory layer." JSONL because the primitive obligation is "be readable without Memento."
2. **Modular.** The exporter and importer are lifecycle commands — they sit outside the registry, share `LifecycleDeps`, and consume the same `MemoryRepository` / event store the rest of the app uses. Replacing the artefact format means swapping one writer and one reader pair; no other module changes.
3. **Extensible.** The format is versioned (`memento-export/v1`) and the record type field is open: future versions add new `type` values (e.g. `config`, `scope_alias`) without breaking v1 readers that ignore unknown types. The header is the negotiation point.
4. **Config-driven.** Two new `ConfigKey`s — `export.includeEmbeddings` (default `false`) and `export.defaultPath` (default `null`) — carry policy. The format-version literal and the on-conflict behaviour are not config (Rule 12: invariants).

## References

- ADR-0001 (SQLite as storage engine).
- ADR-0003 (single command registry) — clarifies why export/import are lifecycle commands, not registry commands.
- ADR-0012 §3 (sensitive flag) — informs the export warning.
- User stories P1.4 and P1.15.
- KNOWN_LIMITATIONS.md — the entry "no portable export" is replaced by this ADR's implementation.
