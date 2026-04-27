# ADR-0005: Conflict detection as a post-write hook

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** conflict, write-path

## Context

Two writes can disagree. Conflicts must be detected, but writes must not block on detection. A pre-write check would either block or be silently disabled when slow; both are bad.

## Decision

Run conflict detection as an asynchronous post-write hook bounded by `conflict.timeoutMs`. The write commits; the hook runs after; conflicts are surfaced via `memory.conflicts` (a separate read path), not via the write's response.

If the hook misses a conflict (timeout, crash), `memento conflicts scan` re-runs detection deterministically over the audit log.

## Consequences

### Positive

- Writes never block on detection.
- Conflicts are visible but not interruptive.
- Re-detection is safe and deterministic.

### Negative

- A small window where a conflict exists but is not yet recorded.
- Users must explicitly check for conflicts (or rely on `conflict.surfaceInSearch`).

### Risks

- The hook silently misses conflicts. Mitigation: `memento doctor` reports conflict-detection lag; `memento conflicts scan` is a one-shot recovery.

## Alternatives considered

### Synchronous, blocking pre-write check

Rejected. Latency cost is unacceptable; pressure to weaken the check defeats the purpose.

### Synchronous-with-timeout pre-write check

Rejected. Silent disablement on slow paths is the worst of both worlds.

### Periodic batch detection

Rejected. Larger windows of undetected conflict; daemon required.

## Validation against the four principles

1. **First principles.** Detection is a derived view, not a blocking precondition. Model it as such.
2. **Modular.** Per-kind policies are pluggable.
3. **Extensible.** Adding a new kind requires adding a policy; the structural test enforces it.
4. **Config-driven.** Timeout, scope strategy, per-kind tuning — all `ConfigKey`s.

## References

- [docs/architecture/conflict-detection.md](../architecture/conflict-detection.md)
