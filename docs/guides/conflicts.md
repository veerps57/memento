# Conflicts

Memento records a **conflict** when a new write would contradict an existing active memory in the same scope (or a broader scope, depending on `conflict.detectionMode`). Conflicts do not block the write — both rows stay active, and Memento surfaces a row in the `conflicts` table so a human (or a sufficiently careful agent) can decide which one wins.

This guide covers how to inspect conflicts, how to resolve them, and which knobs control detection.

## Why this exists

Without conflict detection, a chatty assistant can quietly overwrite "I prefer 4-space indentation" with "I prefer 2-space indentation" the next time the topic comes up, and you lose the audit trail of your actual preference history. With conflict detection, both writes succeed (so neither agent has to retry) and the disagreement becomes a first-class artefact you can resolve later.

The conflict workflow is the deliberate "slow down here" surface in Memento. It's the one place where the system asks for human judgement instead of guessing.

## Inspect conflicts

List unresolved conflicts:

```bash
memento conflict list --input '{"status":"open"}'
```

Read a single conflict:

```bash
memento conflict read --input '{"id":"<conflict-id>"}'
```

Show the audit-event chain for a single conflict (when it was detected, who acknowledged it, when it resolved):

```bash
memento conflict events --input '{"id":"<conflict-id>"}'
```

A `memento status` snapshot includes `conflictCount` (rows where `resolved_at IS NULL`) so you can scan store-wide pressure without enumerating rows.

## Resolve a conflict

`conflict.resolve` takes a conflict id, a resolution policy, and (depending on the policy) which side to keep:

```bash
# keep the new memory, mark the older one superseded
memento conflict resolve --input '{
  "id": "<conflict-id>",
  "policy": "supersede",
  "winner": "incoming"
}'

# keep the existing memory, mark the new one superseded
memento conflict resolve --input '{
  "id": "<conflict-id>",
  "policy": "supersede",
  "winner": "existing"
}'

# acknowledge that the two memories coexist (they are not actually contradictory)
memento conflict resolve --input '{
  "id": "<conflict-id>",
  "policy": "coexist"
}'
```

`supersede` rewrites one of the involved memories' lifecycle to `superseded` and links it to the surviving row, so future reads of the loser still resolve to the winner with the relationship intact. `coexist` clears the conflict without changing either memory.

The full input schemas are in [`docs/reference/mcp-tools.md`](../reference/mcp-tools.md) under the `conflict.*` namespace.

## Re-scan after the fact

If you change `conflict.detectionMode` or import a batch of memories from another machine, you can re-run the detector across the live store:

```bash
memento conflict scan
```

`scan` only inspects pairs that haven't already produced a conflict row, so it is safe to re-run; it does not surface duplicate noise on memories that were already adjudicated.

## Configuration

The relevant config keys (full list in [`docs/reference/config-keys.md`](../reference/config-keys.md)):

- `conflict.detectionMode` — `same-scope`, `same-or-broader`, or `off`. Controls which memory pairs the detector compares. Default: `same-or-broader`.
- `conflict.minConfidenceForDetection` — memories below this confidence are not considered worth comparing. Default: `0.4`.

Conflicts are deliberately not auto-resolved. The detector finds them; the resolver runs only when invoked.

## When the detector is too noisy

If `conflict list` is producing more rows than you want to triage, the right knobs in order of preference are:

1. Tighten `conflict.minConfidenceForDetection` so weakly-asserted memories don't fight each other.
2. Narrow `conflict.detectionMode` to `same-scope` if cross-scope contradictions are mostly false positives in your usage.
3. Resolve in bulk with `conflict.resolve` and the `coexist` policy for batches that are genuinely non-contradictory.

Turning detection off entirely (`conflict.detectionMode = off`) is supported but not recommended; it loses the audit trail that makes Memento useful for "why did I change my mind about X" questions.
