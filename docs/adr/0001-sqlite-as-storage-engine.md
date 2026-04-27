# ADR-0001: SQLite as the storage engine

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** storage, dependencies

## Context

Memento needs durable, queryable, local storage for memories, events, and config. The candidates evaluated:

- **SQLite** (better-sqlite3) — mature, embedded, single-file, FTS5 built-in, sqlite-vec available.
- **DuckDB** — analytic, columnar, better for aggregates, less mature for high-volume small writes.
- **LevelDB / RocksDB** — KV store; we'd build the query layer ourselves.
- **A flat directory of files** — simple, but no indexing, no transactions across entities.
- **A bundled Postgres** — heavy, complex install story, breaks the "no daemon" property.

Memento's workload is: high-frequency small writes, frequent indexed reads, occasional full-text and vector search. Strong transactional semantics across `memories` and `memory_events` are required for the audit guarantee.

## Decision

Use SQLite via `better-sqlite3` as the sole storage engine. Use FTS5 for text search. Make `sqlite-vec` an optional dependency for vector search.

## Consequences

### Positive

- Single-file database; trivial backup, copy, share.
- No server process; no install ceremony.
- Strong transactional semantics for the audit invariant.
- FTS5 ships in SQLite; no separate index process.
- Massive ecosystem familiarity.

### Negative

- Requires a C toolchain to install (`better-sqlite3` builds native).
- Single-writer; concurrent processes need coordination (we use one server process per workspace).
- Vector search needs an additional native dependency.

### Risks

- Native build failures on uncommon platforms. Mitigation: documented prerequisites; the install error from `better-sqlite3` is reasonably actionable.
- sqlite-vec is younger than SQLite; we treat it as optional and ship a brute-force fallback.

## Alternatives considered

### DuckDB

Attractive: better analytical performance, friendlier for ad-hoc reports. Rejected: less proven for high-frequency small writes; weaker FTS story; smaller ecosystem of node bindings.

### LevelDB / RocksDB

Attractive: simple data model, fast writes. Rejected: we would build the query, FTS, and audit layers ourselves — cost not justified.

### Bundled Postgres

Attractive: best-in-class everything. Rejected: violates the "no daemon, no ceremony" property; the install story alone disqualifies it.

## Validation against the four principles

1. **First principles.** SQLite is the lowest-overhead durable store that gives us transactions, FTS, and a viable vector path.
2. **Modular.** Repositories sit on Kysely; swapping the engine means swapping the dialect, not rewriting domain code.
3. **Extensible.** sqlite-vec is opt-in; the brute-force fallback proves the abstraction works without it.
4. **Config-driven.** `storage.path`, `storage.busyTimeoutMs`, `retrieval.vector.backend` are user-facing.

## References

- ADR-0006 (local embeddings)
- [docs/architecture/data-model.md](../architecture/data-model.md)
