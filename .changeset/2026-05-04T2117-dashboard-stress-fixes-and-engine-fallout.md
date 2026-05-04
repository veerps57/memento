---
"@psraghuveer/memento-core": minor
"@psraghuveer/memento-schema": minor
"@psraghuveer/memento-dashboard": minor
---

Dashboard stress-test fix pass + engine corrections it surfaced.

A multi-round audit of the v0 dashboard surfaced eight visible bugs and a stack of UX/copy issues. Closing them required matching engine work: a broken conflict-scan surface, an audit-log gap that made every first-time config edit read as `null → x`, a missing dedup invariant in conflict detection, and three new `system.info` fields. The dashboard was largely rewritten on top of the corrected engine surface — every read view, the inline config editor, the ⌘K palette, the system & health page, and the auth-error UX shipped together so the user-visible polish lands as one coherent change rather than a flurry of single-line PRs.

Functional behaviour on the happy path is unchanged outside the dashboard. Existing CLI / MCP callers see the same output shapes — the new `system.info` fields are additive, the new `ConfigSetInput.priorEffectiveValue` parameter is optional and back-compat (legacy callers that don't pass it keep their existing oldValue=null semantics), and the new `ConflictRepository.openPartners` method extends the interface without changing the existing five.

**Conflict detection** (`@psraghuveer/memento-core`)

- `conflict.scan` is now exposed on the dashboard surface so the conflicts page's "re-scan (24h)" button actually works. Previously the click returned `INVALID_INPUT — Command 'conflict.scan' is not exposed on the dashboard surface`.
- The detector now skips candidates that already share an open conflict with the memory being scanned (either direction). Without this, every press of `re-scan (24h)` and every redundant post-write hook fire inserted a duplicate row for the same logical pair. Observable in the dashboard's overview tile as a count that grew monotonically with the number of clicks. New `ConflictRepository.openPartners(memoryId)` returns the partner-id set in one query; the detector seeds an in-memory mutable copy at the top of the run so newly-opened pairs aren't re-opened later in the same scan.
- `conflict.scan` in `since` mode now reports `scanned` as the number of memories processed, not the candidate-pairing count summed across them. Re-runs over a 5,000-memory corpus used to print `scanned 68413 memories` (the work the detector did, not the size of the haystack); now they print the actual memories processed.

**Config audit log** (`@psraghuveer/memento-core`, `@psraghuveer/memento-schema`)

`config.set` and `config.unset` accept an optional `priorEffectiveValue` field that the engine plumbs from `configStore.entry(key).value` at the command-handler layer. When no prior event exists for the key, OR when the latest event was an `unset` (i.e. the runtime override layer is empty), the audit `oldValue` records the engine's effective value — typically the schema default — instead of literal `null`. The dashboard's per-key history view now reads `100 → 42 by cli` for the first-time edit instead of the previous `null → 42`. Legacy callers that don't pass `priorEffectiveValue` keep the original oldValue=null behaviour.

`@psraghuveer/memento-schema` exports a new `IMMUTABLE_CONFIG_KEY_NAMES` constant — the snapshot of every key flagged `mutable: false` in `CONFIG_KEYS`. The dashboard's config editor consumes this directly so its IMMUTABLE_KEYS gate cannot drift from the engine; a structural test in `packages/schema/test/config-keys.test.ts` pins the relationship.

**`system.info` additions** (`@psraghuveer/memento-core`, `@psraghuveer/memento-schema`)

Three new top-level fields on the output schema:

- `openConflicts: number` — exact aggregate from `SELECT COUNT(*) FROM conflicts WHERE resolved_at IS NULL`. The dashboard's overview tile now reads this directly instead of counting a paged `conflict.list` response capped at `conflict.list.maxLimit`. The previous `1,000+` capped display is gone; resolving a conflict decrements the value monotonically through the existing query-cache invalidation path.
- `runtime: { node, modulesAbi, nativeBinding: 'ok' }` — process-level health subset of `memento doctor`. `nativeBinding` is always `'ok'` because reaching the handler implies the better-sqlite3 .node addon loaded successfully. Powers the dashboard's `~/system` `node` and `native binding` probes.
- `scrubber: { enabled }` — resolved `scrubber.enabled` config. Surfaces the write-path redaction master switch on `~/system` so the operator can confirm the safety net is active. The key remains pinned at server start (`mutable: false`); the boolean here just mirrors the resolved value the engine is actually applying to writes.

The handler description metadata is updated to mention the new fields. Reference docs (`docs/reference/mcp-tools.md`, `docs/reference/cli.md`) regenerated.

**Dashboard surface** (`@psraghuveer/memento-dashboard`)

The package gets a behaviour + visual sweep on the v0 routes:

- **Re-scan button works.** Driven by the engine's `conflict.scan` surface fix.
- **Inline config editor.**
  - The Reset (config.unset) button now renders for runtime overrides — i.e. when `entry.source` is `cli` or `mcp`. The previous predicate compared against the literal `'runtime'`, which is not a member of `ConfigSourceSchema`; the button never rendered.
  - `inferEditorType` treats `null` on the known string-or-null keys (`user.preferredName`, `export.defaultPath`, `embedder.local.cacheDir`) as `'string'`. The previous fallback to JSON forced users to type `"Raghu"` (with quotes) to set their preferred name; bare names failed `JSON.parse`. Empty drafts on these keys are saved as `null` so the field can be cleared without an explicit `config.unset`.
  - `IMMUTABLE_KEYS` now derives from `IMMUTABLE_CONFIG_KEY_NAMES`. Four keys (`embedder.local.timeoutMs`, `embedder.local.cacheDir`, `scrubber.enabled`, `scrubber.rules`) used to render an editor and surface `IMMUTABLE` only on save.
  - Local `ConfigSource` TypeScript type widened to match the schema's actual enum (`default | user-file | workspace-file | env | cli | mcp`); the previous `'default' | 'startup' | 'runtime'` was wrong.
- **Auth-error UX.** A new `TokenMissingPanel` component renders uniformly across every route when the launch token is missing or rejected. Detection lives in the API client (`callCommand`) which short-circuits to a synthetic `AUTH_REQUIRED` code; the app shell subscribes to the React-Query cache and replaces the active route with the panel. Replaces the seven different `failed: …` prefixes that used to surface on each route.
- **Pagination.** `memory.list`, `memory.events`, `conflict.list`, and the memory-detail audit timeline get a "load next 100" affordance up to the engine's `*.maxLimit` ceiling (1,000 by default). The hooks use `keepPreviousData` so the page doesn't snap to the top during the next fetch. State resets when filters change.
- **Filter chips.** Status and kind on `~/memory` are now multi-select sets. The engine takes a single optional `kind`/`status`, so the dashboard sends a wire-level filter only when one chip is active and narrows the rest client-side. Status chips refuse to deselect the last-remaining chip (a zero-status filter is ambiguous without an `all` chip; the four statuses always cover the universe).
- **Mutation invalidation.** `useSetConfig` / `useUnsetConfig` invalidate `system.info` so the wordmark refreshes after a `user.preferredName` edit. `useResolveConflict` and `useScanConflicts` invalidate `system.info` so the overview tile decrements after triage. Memory mutations also invalidate `system.list_scopes`.
- **Visual polish.** Overview rows share a `ACROSS ALL SCOPES` / `BY STATUS` header shape with no per-tile subtexts. `BY STATUS` shows three lifecycle-exit tiles (active is in the headline row). Top-N scope distribution gets a `+ N more scopes (M)` reconciliation row when truncated. The capped `1,000+` open-conflict tile is gone in favour of the exact engine count. The footer's `vec: on/off` indicator is gone (the `~/system` page owns the vector-retrieval probe). Memory + conflict + audit row pills are lowercase in neutral foreground; the `forget` button matches `pin` / `confirm` (no warn tone). Audit row memory-IDs default to white, accent on hover.
- **System & health.** Six probes ordered along the dependency chain: `node` → `database` → `native binding` → `vector retrieval` → `scrubber` → `version`. Indicator dots use a traffic-light mapping (`synapse` for ok, `warn` for warn, `destructive` for off) that's no longer ambiguous between ok and warn. `schema version` and `last write` removed (former invariant, latter content-state). The standalone `embedder` probe rolled into `vector retrieval` (which absorbs the embedder model + dimension on the note line and flips to `warn` when vector is on but embedder is missing).

Plus a regression-test pass: 17 new unit tests cover the new `priorEffectiveValue` paths in the config repository, the schema-default-as-oldValue contract in the config command handler, the `IMMUTABLE_CONFIG_KEY_NAMES` drift-prevention invariant, the conflict detector's two dedup branches (re-run on the same memory; reverse-direction pair), and the three `system.info` additions. The total moves from 1,211 → 1,225 passing tests.
