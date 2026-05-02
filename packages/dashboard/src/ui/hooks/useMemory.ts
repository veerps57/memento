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
  readonly embedding: unknown;
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
      // could now match differently), and the kind-count
      // snapshot used by the landing page.
      void qc.invalidateQueries({ queryKey: ['memory.read', vars.id] });
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.search'] });
      void qc.invalidateQueries({ queryKey: ['memory.events'] });
      void qc.invalidateQueries({ queryKey: ['system.info'] });
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
    },
  });
}
