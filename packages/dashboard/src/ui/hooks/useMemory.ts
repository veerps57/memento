// React-Query hooks for the `memory.*` registry surface.
//
// Centralises the wire shapes the API client returns so every
// memory-shaped view (browse list, detail page, audit feed) reads
// from the same TypeScript types without each one re-declaring
// the row shape inline.
//
// Mutations (`memory.update`, `memory.forget`) invalidate the
// list / read / events / system caches so the UI reflects the
// new state without a manual refresh.

import {
  type UseMutationResult,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { callCommand } from '../lib/api.js';
import { unwrap } from '../lib/query.js';

/**
 * Wire shape for a memory row. Mirrors `MemorySchema` from
 * `@psraghuveer/memento-schema` but kept locally so the
 * dashboard's TypeScript types don't depend on the schema's
 * Zod-branded `Path` / `RepoRemote` types (which the API client
 * erases on the wire).
 */
export type EmbeddingStatus = 'present' | 'stale' | 'pending' | 'disabled';

export interface MemoryRow {
  readonly id: string;
  readonly createdAt: string;
  readonly schemaVersion: number;
  readonly scope: { readonly type: string; readonly [k: string]: unknown };
  readonly owner: { readonly type: string; readonly id: string };
  readonly kind: { readonly type: string; readonly [k: string]: unknown };
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly content: string | null;
  readonly summary: string | null;
  readonly status: 'active' | 'superseded' | 'forgotten' | 'archived';
  readonly storedConfidence: number;
  readonly lastConfirmedAt: string;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  /**
   * The raw embedding row, when the engine response carried it
   * (typically `null` for list/search/context — those projections
   * strip the 768 floats by default). When non-null, the
   * `{model, dimension}` pair is what `embeddingStatus` is
   * compared against to decide `'present'` vs `'stale'`.
   */
  readonly embedding: {
    readonly model: string;
    readonly dimension: number;
    readonly vector?: readonly number[];
    readonly createdAt?: string;
  } | null;
  /**
   * Wire-level projection of "is this row's vector usable by the
   * vector arm of search?" Set on every memory output (list,
   * search, context, read, write, etc.). See the engine's
   * `computeEmbeddingStatus` for the full semantics.
   */
  readonly embeddingStatus?: EmbeddingStatus;
  readonly sensitive: boolean;
  readonly redacted?: boolean;
}

/**
 * Wire shape for a memory event. Discriminator is `type`; the
 * payload differs per type but the dashboard treats unknown
 * payload shapes as opaque (we render the type + actor + at
 * line; the detail panel renders type-specific payload fields).
 */
export interface MemoryEventRow {
  readonly id: string;
  readonly memoryId: string;
  readonly at: string;
  readonly type:
    | 'created'
    | 'confirmed'
    | 'updated'
    | 'superseded'
    | 'forgotten'
    | 'restored'
    | 'archived'
    | 'reembedded';
  readonly actor: { readonly type: string; readonly id?: string };
  readonly payload?: unknown;
  readonly scrubReport?: unknown;
}

export type MemoryStatus = 'active' | 'superseded' | 'forgotten' | 'archived';
export type MemoryKindName = 'fact' | 'preference' | 'decision' | 'todo' | 'snippet';

// We keep these `T | undefined` rather than `T?` so callers can
// pass already-conditional values (`kind ?? undefined`) under
// the project's `exactOptionalPropertyTypes` TS option without
// extra spread logic at the call site.
export interface MemoryListFilter {
  readonly status?: MemoryStatus | undefined;
  readonly kind?: MemoryKindName | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly pinned?: boolean | undefined;
  readonly limit?: number | undefined;
}

export function useMemoryList(filter: MemoryListFilter = {}) {
  return useQuery({
    queryKey: ['memory.list', filter],
    queryFn: async () =>
      unwrap(
        await callCommand<readonly MemoryRow[]>('memory.list', {
          status: filter.status,
          kind: filter.kind,
          tags: filter.tags,
          pinned: filter.pinned,
          limit: filter.limit ?? 200,
        }),
      ),
    // Keep the prior page's rows on screen while the next page
    // fetches. Without this, the load-more flow flickers to a
    // "loading…" message that empties the list — the browser
    // loses its scroll anchor and snaps to the top.
    placeholderData: keepPreviousData,
  });
}

export interface MemorySearchFilter {
  readonly text: string;
  readonly kinds?: readonly MemoryKindName[] | undefined;
  readonly includeStatuses?: readonly MemoryStatus[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface MemorySearchResult {
  readonly memory: MemoryRow;
  readonly score: number;
  readonly breakdown: {
    readonly fts?: number;
    readonly vector?: number;
    readonly confidence?: number;
    readonly recency?: number;
    readonly scope?: number;
    readonly pinned?: number;
  };
}

export interface MemorySearchOutput {
  readonly results: readonly MemorySearchResult[];
  readonly nextCursor?: string | null;
}

export function useMemorySearch(filter: MemorySearchFilter | null) {
  return useQuery({
    queryKey: ['memory.search', filter],
    enabled: filter !== null && filter.text.trim().length > 0,
    queryFn: async () =>
      unwrap(
        await callCommand<MemorySearchOutput>('memory.search', {
          text: filter?.text,
          kinds: filter?.kinds,
          includeStatuses: filter?.includeStatuses ?? ['active'],
          tags: filter?.tags,
          limit: filter?.limit ?? 100,
        }),
      ),
    // Keep the previous query's results visible while the next
    // one is in flight. Without this, every keystroke past the
    // debounce window blanks the result list to `undefined` for
    // the duration of the fetch — visually that reads as a flash
    // of "no matches" / "searching…" between every transition.
    // Set on the search hook (not list/read) because only search
    // is driven by user typing.
    placeholderData: keepPreviousData,
  });
}

export function useMemoryRead(id: string | null) {
  return useQuery({
    queryKey: ['memory.read', id],
    enabled: id !== null,
    queryFn: async () =>
      unwrap(
        await callCommand<MemoryRow>('memory.read', {
          id,
        }),
      ),
  });
}

export interface MemoryEventsFilter {
  readonly id?: string | undefined;
  readonly types?: readonly MemoryEventRow['type'][] | undefined;
  readonly limit?: number | undefined;
}

export function useMemoryEvents(filter: MemoryEventsFilter) {
  return useQuery({
    queryKey: ['memory.events', filter],
    queryFn: async () =>
      unwrap(
        await callCommand<readonly MemoryEventRow[]>('memory.events', {
          id: filter.id,
          types: filter.types,
          limit: filter.limit ?? 200,
        }),
      ),
    // Same load-more reasoning as `useMemoryList`.
    placeholderData: keepPreviousData,
  });
}

export interface UpdateMemoryArgs {
  readonly id: string;
  readonly patch: {
    readonly tags?: readonly string[];
    readonly kind?: { readonly type: string };
    readonly pinned?: boolean;
    readonly sensitive?: boolean;
  };
}

export function useUpdateMemory(): UseMutationResult<MemoryRow, Error, UpdateMemoryArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args) =>
      unwrap(await callCommand<MemoryRow>('memory.update', args)) as MemoryRow,
    onSuccess: (_data, vars) => {
      // Invalidate everything that could now be stale: the row
      // itself, every list query (status / kind / tag filters
      // could now match differently), the kind-count snapshot
      // used by the landing page, and the scope list (a memory
      // becoming pinned / sensitive doesn't change its scope, but
      // future patches may, and explicit invalidation keeps the
      // landing page from flashing stale data).
      void qc.invalidateQueries({ queryKey: ['memory.read', vars.id] });
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.search'] });
      void qc.invalidateQueries({ queryKey: ['memory.events'] });
      void qc.invalidateQueries({ queryKey: ['system.info'] });
      void qc.invalidateQueries({ queryKey: ['system.list_scopes'] });
    },
  });
}

export interface ForgetMemoryArgs {
  readonly id: string;
  readonly reason: string | null;
}

export function useForgetMemory(): UseMutationResult<MemoryRow, Error, ForgetMemoryArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }) =>
      unwrap(
        await callCommand<MemoryRow>('memory.forget', {
          id,
          reason,
          // Safety gate is `confirm: literal(true)` per ADR-0012;
          // the UI's confirm modal is what gates the call site.
          confirm: true,
        }),
      ) as MemoryRow,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['memory.read', vars.id] });
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.search'] });
      void qc.invalidateQueries({ queryKey: ['memory.events'] });
      void qc.invalidateQueries({ queryKey: ['system.info'] });
      void qc.invalidateQueries({ queryKey: ['system.list_scopes'] });
    },
  });
}

export interface EmbeddingRebuildResult {
  readonly scanned: number;
  readonly embedded: readonly string[];
  readonly skipped: readonly {
    readonly id: string;
    readonly reason: string;
  }[];
}

/**
 * Trigger `embedding.rebuild` — re-embed memories whose stored
 * vector mismatches the configured embedder (`embeddingStatus:
 * 'stale'`). Returns a per-call summary (`scanned` / `embedded`
 * / `skipped`).
 *
 * The engine command is batched server-side and idempotent.
 * Successive calls drain the stale set; the caller may need to
 * call again if the stale set is larger than one batch (the
 * engine's `embedding.rebuild.defaultBatchSize` config, default
 * `100`). The UI surfaces this by re-invalidating
 * `memory.list` / `memory.search` queries on success — the
 * banner-with-rebuild-button re-evaluates whether stale rows
 * remain after the next refetch.
 */
export interface EmbeddingRebuildArgs {
  readonly batchSize?: number;
}

export function useEmbeddingRebuild(): UseMutationResult<
  EmbeddingRebuildResult,
  Error,
  EmbeddingRebuildArgs
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args) =>
      unwrap(
        await callCommand<EmbeddingRebuildResult>('embedding.rebuild', {
          ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
        }),
      ) as EmbeddingRebuildResult,
    onSuccess: () => {
      // Re-embed events bump `lastConfirmedAt` audit trail and
      // update per-row `embeddingStatus` from `'stale'` to
      // `'present'`. Invalidate the read paths so the banner +
      // table reflect the new state on the next refetch.
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.search'] });
      void qc.invalidateQueries({ queryKey: ['memory.read'] });
      void qc.invalidateQueries({ queryKey: ['memory.events'] });
      void qc.invalidateQueries({ queryKey: ['system.info'] });
    },
  });
}

export function useConfirmMemory(): UseMutationResult<MemoryRow, Error, { readonly id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }) =>
      unwrap(await callCommand<MemoryRow>('memory.confirm', { id })) as MemoryRow,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['memory.read', vars.id] });
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.events'] });
      // confirm bumps `lastConfirmedAt`, which affects the
      // landing page's "last write per scope" tile via
      // system.list_scopes and the system page's "last write"
      // via system.info.
      void qc.invalidateQueries({ queryKey: ['system.info'] });
      void qc.invalidateQueries({ queryKey: ['system.list_scopes'] });
    },
  });
}
