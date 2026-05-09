# Conflicts

Memento records a **conflict** when a new write would contradict an existing active memory in the same scope (or a broader scope, depending on `conflict.scopeStrategy`). Conflicts do not block the write — both rows stay active, and Memento surfaces a row in the `conflicts` table so a human (or a sufficiently careful agent) can decide which one wins.

This guide covers how to inspect conflicts, how to resolve them, and which knobs control detection.

## Why this exists

Without conflict detection, a chatty assistant can quietly overwrite "I prefer 4-space indentation" with "I prefer 2-space indentation" the next time the topic comes up, and you lose the audit trail of your actual preference history. With conflict detection, both writes succeed (so neither agent has to retry) and the disagreement becomes a first-class artefact you can resolve later.

The conflict workflow is the deliberate "slow down here" surface in Memento. It's the one place where the system asks for human judgement instead of guessing.

## Inspect conflicts

List unresolved conflicts:

```bash
memento conflict list --input '{"open":true}'
```

The `conflict.list` filter is `{ open?: boolean, kind?: MemoryKind, memoryId?: ULID, limit?: number }`. Pass `open: true` for unresolved only, `open: false` for resolved only, or omit `open` entirely to list both.

Read a single conflict:

```bash
memento conflict read --input '{"id":"<conflict-id>"}'
```

Show the audit-event chain for a single conflict (when it was detected, who resolved it, with what resolution):

```bash
memento conflict events --input '{"id":"<conflict-id>"}'
```

A `memento status` snapshot includes `conflictCount` (rows where `resolved_at IS NULL`) so you can scan store-wide pressure without enumerating rows.

## Resolve a conflict

`conflict.resolve` takes a conflict id and one of four resolutions. The resolver writes a `resolved` event with the chosen value; **it does not touch the involved memories' lifecycle.** Any structural side-effects (forgetting the loser, superseding one with the other) are the caller's responsibility — the resolution is an audit decision, not a state-machine transition.

```bash
# accept the newer memory as authoritative
memento conflict resolve --input '{"id":"<conflict-id>","resolution":"accept-new"}'

# accept the existing memory as authoritative
memento conflict resolve --input '{"id":"<conflict-id>","resolution":"accept-existing"}'

# acknowledge the two memories coexist (e.g. the detector was over-eager)
memento conflict resolve --input '{"id":"<conflict-id>","resolution":"ignore"}'

# defer to a manual supersede the caller will run separately
memento conflict resolve --input '{"id":"<conflict-id>","resolution":"supersede"}'
```

The four valid resolutions are `accept-new`, `accept-existing`, `supersede`, and `ignore`. After resolving, follow up with `memento memory forget` or `memento memory supersede` if you need the corresponding lifecycle change.

The full input schemas are in [`docs/reference/mcp-tools.md`](../reference/mcp-tools.md) under the `conflict.*` namespace.

## Re-scan after the fact

If you flip `conflict.scopeStrategy` or import a batch of memories from another machine, re-run the detector across the live store. `conflict.scan` has two modes — `memory` to recheck a single id, `since` to replay detection over every memory created at or after a timestamp:

```bash
# recheck one memory after a config change
memento conflict scan --input '{"mode":"memory","memoryId":"<memory-id>"}'

# replay detection across everything written in the last week
memento conflict scan --input '{"mode":"since","since":"2026-05-03T00:00:00.000Z"}'
```

Mode is required (the schema rejects bare `conflict.scan` calls) and the matching field — `memoryId` for `memory`, `since` for `since` — is required by `.refine()`. Already-resolved conflicts are not re-opened; the scan emits a fresh `Conflict` row only for pairs that don't already have one.

## Configuration

The relevant config keys (full list in [`docs/reference/config-keys.md`](../reference/config-keys.md)):

- `conflict.enabled` — master switch (default `true`). When `false` the post-write hook is skipped entirely.
- `conflict.scopeStrategy` — `'same'` (default) or `'effective'`. Controls which candidate set the post-write hook compares the new memory against: `same` checks only the new memory's own scope; `effective` widens to the layered effective scope set.
- `conflict.timeoutMs` — per-write detection budget. Hook runs that exceed this are dropped with a `conflict.timeout` warning; recovery is via `conflict.scan`.
- `conflict.fact.overlapThreshold` — minimum shared-token count for the fact policy's "stance flip" heuristic to fire (default 3).

Conflicts are deliberately not auto-resolved. The detector finds them; the resolver runs only when invoked.

## When the detector is too noisy

If `conflict list` is producing more rows than you want to triage, the right knobs in order of preference are:

1. Narrow `conflict.scopeStrategy` to `'same'` (the default) if cross-scope contradictions are mostly false positives in your usage.
2. Raise `conflict.fact.overlapThreshold` so fact-policy comparisons require more shared vocabulary before flipping into "conflict" mode.
3. Resolve in bulk with `conflict.resolve` and the `coexist` policy for batches that are genuinely non-contradictory.

Turning detection off entirely (`conflict.enabled = false`) is supported but not recommended; it loses the audit trail that makes Memento useful for "why did I change my mind about X" questions.
