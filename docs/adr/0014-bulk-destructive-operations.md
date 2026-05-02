# ADR-0014: Bulk-destructive operations — `forget_many` / `archive_many` with cap and dry-run

- **Status:** Accepted
- **Date:** 2026-04-26
- **Deciders:** core
- **Tags:** registry, safety, lifecycle

## Context

Today the destructive verbs in the registry are strictly per-id: `memory.forget` and `memory.archive` each take a single `MemoryId`. A user who wants to "forget everything that came in through the failed import yesterday" or "archive the entire `scratch` scope" has to enumerate ids client-side, write a loop, and accept that any error halfway through leaves the store in a half-finished state.

The KNOWN_LIMITATIONS file already promises bulk-destructive operations with `dryRun: true` defaults (line 47), and the user-story audit calls this gap out twice: P1.7 ("bulk-destructive operations are not surprising") flatly fails because the operations do not exist, and P3.13 ("reversibility of operational actions") is downgraded to **Partial** because the second half of the criterion — _"or gated behind explicit confirmation"_ — has no implementation surface.

The forces in play:

- **The user is in the loop, not the assistant.** An assistant that fires `memory.forget_many` against a generous filter could evict the entire store. The shape must make the size of the blast radius visible _before_ anything mutates.
- **Per-row audit must hold.** Bulk operations cannot create a shortcut around the per-row `MemoryEvent`. Every transition must look identical in the audit log to a sequence of N individual calls.
- **The existing single-row gate stays.** `confirm: z.literal(true)` is a Rule 12 invariant from ADR-0012. Bulk variants inherit it — they are at least as destructive as their single-row siblings.
- **Operators tune ceilings, not shape.** Rule 2 says the numeric cap is a `ConfigKey`, not a hard-coded constant. The shape of the safety check (matched count vs cap) is the invariant.
- **Dry-run is rehearsal, not preview.** A `dryRun: true` call must observe the same filter, the same eligibility check, and return the same `ids` it _would_ touch — so the user can inspect the artefact and re-run with `dryRun: false` against an unchanged store.

## Decision

We add two commands and one config key. Both commands live next to their per-id siblings on the same `mcp` + `cli` surfaces and share the same destructive `sideEffect`.

### Commands

```text
memory.forget_many   { filter, reason, dryRun, confirm }
memory.archive_many  { filter, dryRun, confirm }
```

Input schema:

- `filter` — a strict subset of `MemoryListFilter` exposed at the command boundary. `scope`, `kind`, `pinned`, and `createdAtLte` are accepted; **`status` is fixed by the verb** rather than caller-controllable (forget targets `active`, archive targets `active | forgotten | superseded`). The empty filter is a `INVALID_INPUT` to prevent "forget everything" by accident — the caller must narrow by at least one dimension.
- `reason` (`forget_many` only) — nullable free text capped at 512 chars, mirroring `MemoryForgetInputSchema.reason`. The same reason is recorded on every per-row `forgotten` event.
- `dryRun: boolean` — **defaults to `true`**. The default is the rehearsal, not the action.
- `confirm: z.literal(true)` — required even in dry-run. The Rule 12 invariant is "destructive verbs require an explicit acknowledgement"; the dry-run flag does not relax that.

Output (`MemoryBulkResultSchema`):

```json
{
  "dryRun": true,
  "matched": 42,
  "applied": 0,
  "idempotent": 0,
  "ids": ["01J..."]
}
```

### Config key

```ts
'safety.bulkDestructiveLimit': defineKey({
  schema: z.number().int().min(1).max(100_000),
  default: 1000,
  mutable: true,
})
```

Semantics: when `dryRun: false` and `matched > limit`, the command returns `INVALID_INPUT` with a message naming both numbers and pointing at the cap key. Dry-run rehearsals are **not** capped — the entire purpose of dry-run is to discover that the filter selects too much. The cap protects committed writes, not previews.

The default (`1000`) is roomy enough for routine clean-ups and small enough that an unattended assistant cannot evict the typical store. Operators with larger stores raise it through the same `config.set` path as every other knob.

### Per-row execution semantics

Each matched row goes through the existing `MemoryRepository.forget` / `MemoryRepository.archive` method in its own transaction. The bulk command is an iterator over the per-row primitives; it does **not** introduce a new "bulk-transactional" path. Two consequences:

1. **Audit is identical to N single calls.** The audit log shows N separate `'forgotten'` (or `'archived'`) events with their per-id memoryId, actor, and timestamp.
2. **Failure is best-effort, not all-or-nothing.** If a row transition fails partway through, earlier transitions are already committed. The output's `applied` count tells the caller how many landed; ids beyond that index are present in `ids` but were not touched.

The all-or-nothing alternative (`db.transaction` wrapping the whole loop) was rejected: it would either require duplicating the per-row lifecycle helper inside the bulk path, or holding the writer lock across an unbounded number of rows. The per-row composition reuses one well-tested code path and preserves the existing concurrency story.

`archive_many` rides on `MemoryRepository.archive`'s built-in idempotency: rows whose status is already `archived` are returned unchanged, no event written. They are counted in `idempotent`, not `applied`.

### CLI surface (deferred)

These commands are MCP-and-CLI like every other `memory.*` verb, which means the existing CLI dispatch (`memento exec memory.forget_many ...`) covers them. A dedicated `memento forget` / `memento archive` lifecycle subcommand is **not** added in this ADR — there is no flag handling beyond what the generic command surface already provides, and a custom CLI front-end would be a parallel maintenance surface for no user-visible win.

## Consequences

### Positive

- Closes P1.7 (bulk-destructive verbs with `dryRun` and the cap gate) and the second half of P3.13 (the "_or_ gated behind explicit confirmation" clause).
- The `safety.bulkDestructiveLimit` key gives operators one knob to tune the entire bulk-destructive surface; future bulk verbs (e.g. `memory.update_many`) inherit it.
- Dry-run-default is the safe-by-default policy: a forgetful caller that omits `dryRun` runs a rehearsal, not the act.
- Every transition is still a per-row `MemoryEvent`. P1.5 (audit) and P3.13's reversibility (each row is restorable via `memory.restore`) hold without modification.

### Negative

- Two new commands × the registry × the docs generator = another ~250 lines surface area to maintain.
- The cap is a soft gate — a determined caller can always raise it via `config.set`. The defence is logging on large bulk applies, not refusal. Operators who want a hard ceiling get it by setting the key to their preferred number; raising it is itself an audited config change.
- Failure mid-loop leaves a partially-applied result. We document this prominently rather than paper over it.

### Risks

- **Filter drift.** A filter that matches under the rehearsal may match a different set under the real apply if the store changes in between. The output reports the ids actually touched; callers concerned about strict rehearsal/apply correspondence pin the filter by passing the explicit `ids` set returned from the dry-run as the filter on the apply (a follow-up ADR may add an `ids: MemoryId[]` filter dimension; not in v1 scope).
- **Cap raise into infinite-loop territory.** An operator who sets the cap to 100_000 and points the filter at a multi-tenant store could lock up the writer. The schema `max(100_000)` is the hard ceiling; we deliberately do not allow a value above that.

## Alternatives considered

### Alternative A: Server-side filter query language

Allow the caller to pass arbitrary SQL or a richer expression tree. Rejected: the existing `MemoryListFilter` covers every documented user need (P1.7's examples are all "scope+kind+age" shaped) and a query language is its own maintenance surface plus injection-vector concern.

### Alternative B: Single transaction across the whole bulk

Wrap the whole loop in `db.transaction()`. Rejected because:

- It would require duplicating the per-row lifecycle helper.
- It would hold the writer lock for the duration — the cap protects against blast radius _on commit_, not against long-held locks.
- The user-visible benefit (true atomicity) does not outweigh the cost: each row's transition is independently meaningful and independently audited.

### Alternative C: Confirm only above the cap

The KNOWN_LIMITATIONS line could be read as "confirm is only required when matched > cap." Rejected for consistency with the per-row siblings: `memory.forget` and `memory.archive` require `confirm: true` unconditionally, and the bulk variants must not be _weaker_ than the single-row primitives they extend.
