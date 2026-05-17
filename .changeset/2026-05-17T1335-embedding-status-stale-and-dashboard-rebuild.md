---
'@psraghuveer/memento-schema': minor
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-dashboard': minor
---

feat: surface stale embeddings (new `embeddingStatus: 'stale'` value + dashboard rebuild surface)

The wire-level `embeddingStatus` enum on every memory output (`memory.read`, `memory.list`, `memory.search`, `memory.context`, `memory.write`, etc.) gains a fourth value, **`'stale'`**, to mean: "the row has an embedding, but its `model` / `dimension` mismatch the configured embedder, so the vector arm of search will skip it until `embedding.rebuild` re-embeds it."

Pre-change, `embeddingStatus` was binary on the "is there a vector?" axis: `'present'` (any non-null row) / `'pending'` (no row yet) / `'disabled'` (vector arm off). After a user changed `embedder.local.model` (or installed a fresh build with a different default), every previously-embedded row continued to report `'present'` even though the vector arm would silently skip it. The "stale" state was real (the bulk re-embed driver's `isFresh` check has always treated mismatched rows as rebuild candidates) but invisible to dashboards, scripts, and assistants.

**What changes for consumers**

- **Wire schema (`@psraghuveer/memento-schema`):** `embeddingStatus: z.enum(['present', 'stale', 'pending', 'disabled']).optional()` — additive. Existing consumers that branch on `'present'` keep working; consumers that exhaustively match all values now need a `'stale'` case (TypeScript will surface the gap at the call site).

- **`computeEmbeddingStatus` (`@psraghuveer/memento-core`):** new optional third argument `configuredEmbedder?: {model, dimension}`. When supplied, embedded rows whose model / dim mismatch return `'stale'`; when omitted, embedded rows fall back to `'present'` (legacy host shape — hosts without an active embedder have no comparison point, so the safer answer is to leave behavior unchanged for those hosts).

- **Tool descriptions:** `memory.search` and `memory.context` MCP tool descriptions now document all four values and explain the `'stale'` remediation (`run embedding.rebuild`). The auto-generated `docs/reference/mcp-tools.md` + `docs/reference/cli.md` are updated accordingly.

- **Shared helper:** new `isEmbeddingFresh(embedding, configuredEmbedder)` in `@psraghuveer/memento-core/embedding`. Single source of truth for "is this embedding row current?" — replaces the duplicated local check inside `reembedAll` and matches the read-time `computeEmbeddingStatus` projection.

- **`embedding.rebuild` gains the `'dashboard'` surface.** Previously `mcp+cli` only. The dashboard's UI now calls this command directly via the existing registry-over-HTTP proxy.

**Dashboard (`@psraghuveer/memento-dashboard`)**

- **Per-row embedding badge** on `/memory`. Renders next to the existing pinned / sensitive badges when status is anything other than `'present'` (the silent default). `stale` is warn-toned with a hover tooltip explaining the model/dim mismatch; `pending` / `disabled` are muted-toned with their own explanations.

- **"Stale only" filter chip.** Toggles client-side narrowing of the result list to rows with `embeddingStatus === 'stale'`. There is no engine-side `embeddingStatus` filter on `memory.list` yet, so the narrowing applies to whatever the engine already paged in — the count is "stale in this view," not a global tally.

- **Rebuild banner.** When any row in the current view is `stale`, a warn-toned banner above the result list explains the situation and offers a "rebuild stale embeddings" button. The button calls `embedding.rebuild` via the new `useEmbeddingRebuild` mutation hook; on success, the hook invalidates `memory.list` / `memory.search` / `memory.read` / `memory.events` / `system.info` so the badge / banner re-evaluate on next render. Per-call success and error summaries render inline below the banner.

- **Memory-detail page additions.** The header pill row gains an embedding pill matching the list-page badge; the tooltip on the `stale` pill carries the full `stored ${model}@${dim}d vs configured ${model}@${dim}d` comparison so the user can see the exact mismatch without leaving the page. A `rebuild` action button appears in the action row alongside `pin` / `confirm` / `forget` when the current memory is `stale`.

**Tests**

- `packages/core/test/commands/memory.test.ts` gains two cases inside the existing `embeddingStatus + lean responses` describe block: one that pins `'stale'` on a configured-embedder mismatch, and one that pins the legacy `'present'` fallback when no `configuredEmbedder` is wired.
- `packages/core/test/commands/conflict-embedding-compact.test.ts` updated to assert the new `['mcp', 'cli', 'dashboard']` surface set on `embedding.rebuild`.
- All 1614 existing tests pass plus the 2 new ones (1616 total).
