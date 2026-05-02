# Architecture: Conflict Detection

This document describes how Memento detects when a new memory contradicts an existing one, and how it surfaces those contradictions without blocking writes.

## The problem

Two writes can disagree:

- The agent learned yesterday "we use PostgreSQL", and today writes "we use MySQL".
- One agent writes "build with `pnpm build`", another writes "build with `npm run build`".
- A user-recorded preference says "tabs", a tool-inferred preference says "spaces".

Silent contradictions are corrosive: they teach the model wrong things. Loud contradictions that block writes are worse: they break the agent's flow and train users to ignore them.

Memento's answer: detect conflicts asynchronously after the write commits, and surface them via a dedicated read path. Writes never block on conflict checks.

## The hook

After a `memory.write` or `memory.supersede` commits, the conflict-detection hook is enqueued:

```text
memory.write → commit → return to caller
                  │
                  └─▶ enqueue ConflictCheckJob
                          │
                          ▼
                  ┌────────────────────┐
                  │ Conflict detector  │
                  │ • candidate fetch  │
                  │ • per-kind rules   │
                  │ • emit event       │
                  └────────────────────┘
```

The job is bounded: if it does not complete within `conflict.timeoutMs` (default `2000`), it is dropped and a `conflict.timeout` warning is logged. Dropping is safe — the next write or an explicit `memento conflict scan` will catch the missed check.

The hook runs in the same process; there is no worker queue, no background daemon, no cross-process coordination. The simplicity is deliberate.

## Detection

For each new memory, the detector:

1. Fetches candidates via the retrieval pipeline restricted to the same scope (or the layered scope set, depending on `conflict.scopeStrategy`).
2. For each candidate, runs the **per-kind conflict policy** registered for the new memory's `kind`.
3. If a conflict is detected, writes a `conflict` event with `{ newMemoryId, conflictingMemoryId, kind, evidence }`.

### Per-kind conflict policies

Conflict semantics differ by kind:

| Kind         | What counts as a conflict                                                              |
| ------------ | -------------------------------------------------------------------------------------- |
| `fact`       | Same subject, contradictory predicate (heuristic: high text overlap + opposite stance) |
| `preference` | Same preference key, different value                                                   |
| `decision`   | Same decision context, different choice                                                |
| `todo`       | Identical action, different `done` state                                               |
| `snippet`    | Same identifier in same language, different body                                       |

Each policy is implemented as a function that takes `(newMemory, candidate, config)` and returns `{ conflict: true, evidence } | { conflict: false }`. Policies are registered at module load; the structural test asserts that every `MemoryKind` has a policy. Adding a new kind without adding a policy fails the build.

The default heuristics are intentionally conservative — Memento prefers a few high-confidence conflicts to many low-confidence ones. Tuning is via `conflict.<kind>.*` config.

## Surfacing

Conflicts are read, not pushed:

- `list_conflicts` (MCP) and `memento conflict list` (CLI) return open conflicts for a scope.
- `conflict.resolve <conflictId>` accepts one of `{accept-new, accept-existing, supersede, ignore}` and writes a `conflict.resolved` event.

Open conflicts also appear in `memento doctor` output. They never appear in the response to `memory.write` itself — the write is committed and the caller's flow is preserved. (`memento conflict list` enumerates the same backlog.)

This makes conflict triage a deliberate user action rather than an interruption. The agent can be configured (`conflict.surfaceInSearch`) to include conflict markers alongside `memory.search` results when relevant, so the conflict is visible at the moment of use.

## Why post-write, not pre-write

A pre-write conflict check would either:

- **Block the write** until detection completes — bad for latency, bad for the agent's experience, and creates pressure to weaken the check until it is fast enough not to matter.
- **Run synchronously and silently drop on slow paths** — making conflict detection nondeterministic in the worst possible way (silently disabled when it matters most).

Post-write detection is decoupled from the write's success and can take as long as `conflict.timeoutMs` without affecting the caller. Writes are always durable; conflicts are eventually surfaced.

## Why the audit log makes this safe

Because conflict detection is async, a conflict between two memories can in principle be missed (e.g., both writes' detection jobs fail). The audit log makes recovery cheap: `conflict.scan` accepts either a single `memoryId` (replay one memory) or a `since` timestamp (replay every active memory created at or after it) and re-runs detection over the historical window. The detection function is pure over `(memory, candidates, config)`, so re-runs are deterministic.

## Configuration

| Key                             | Purpose                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| `conflict.enabled`              | Master toggle. Default `true`.                                    |
| `conflict.timeoutMs`            | Per-write detection budget. Default `2000`.                       |
| `conflict.scopeStrategy`        | `'same'` or `'effective'`. Default `'same'`.                      |
| `conflict.<kind>.*`             | Per-kind tuning knobs.                                            |
| `conflict.surfaceInSearch`      | Whether `memory.search` flags involved memories. Default `true`.  |
| `conflict.maxOpenBeforeWarning` | Threshold above which `memento doctor` raises a triage-backlog warning. Default `50`. |

## What this enables

- **No silent contradictions.** Conflicting memories are recorded and surfaced.
- **No write-path blocking.** The agent's flow is not interrupted by detection latency.
- **Deterministic re-detection.** History is replayable.

## What this deliberately omits

- **Auto-resolution.** Memento never decides which side of a conflict is right. Resolution is always a user (or agent) action with a logged actor.
- **Cross-scope conflict by default.** A `repo` memory and a `global` memory can disagree without raising a conflict; layering already surfaces both. `conflict.scopeStrategy = 'effective'` opts in.
- **LLM-based conflict detection.** Heuristics only. An LLM-driven policy is a future extension via the existing per-kind policy interface.
