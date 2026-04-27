# ADR-0004: Lazy, query-time decay (no scheduled jobs)

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** decay, retrieval

## Context

Memento ages information so old, unconfirmed memories ranked below fresh confirmed ones. Two designs:

- **Eager / scheduled:** materialize `effectiveConfidence` periodically; mutate rows.
- **Lazy / query-time:** compute `effectiveConfidence` from `(storedConfidence, lastConfirmedAt, halfLife, now)` at every query.

Scheduled materialization requires a daemon (or invasive cron-like behavior in the server process), produces stale results between runs, and is wrong under retroactive config change (e.g., the user adjusts a half-life — every row needs recomputing).

## Decision

Compute decay at query time. Do not materialize `effectiveConfidence` in the database. The only background-style operation is `memento compact`, which transitions long-cold memories to `archived` and is run explicitly by the user (or scheduled by them externally).

## Consequences

### Positive

- No daemon. No "did the job run?" failure mode.
- Retroactive config changes are correct without reindexing.
- The decay formula is a pure function; trivially testable.

### Negative

- Per-query cost: one floating-point multiply per candidate. Negligible at the scales Memento targets.

### Risks

- Very large candidate sets could amplify the per-query cost. Mitigation: scope filter and FTS prune before ranking; the candidate cap is bounded.

## Alternatives considered

### Scheduled materialization

Rejected for the reasons above.

### Per-memory expiry (TTL)

Rejected — see [decay-and-supersession.md](../architecture/decay-and-supersession.md). TTL throws away true things.

## Validation against the four principles

1. **First principles.** Decay is a property of the query, not the storage. Modeling it as such removes a daemon.
2. **Modular.** The decay function is pluggable via `retrieval.ranker.strategy`.
3. **Extensible.** New decay shapes (linear, exponential, custom) are config + a function.
4. **Config-driven.** Half-lives are per `MemoryKind`, all `ConfigKey`s.

## References

- [docs/architecture/decay-and-supersession.md](../architecture/decay-and-supersession.md)
