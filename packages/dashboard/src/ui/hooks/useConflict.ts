// React-Query hooks for the `conflict.*` registry surface.
//
// The conflicts page reads `conflict.list`, hydrates each row's
// two referenced memories via `memory.read`, and offers
// resolutions via `conflict.resolve`. A "re-scan" button calls
// `conflict.scan`.

import {
  type UseMutationResult,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { callCommand } from '../lib/api.js';
import { unwrap } from '../lib/query.js';

export type ConflictResolution = 'accept-new' | 'accept-existing' | 'supersede' | 'ignore';

export interface ConflictRow {
  readonly id: string;
  readonly newMemoryId: string;
  readonly conflictingMemoryId: string;
  readonly kind: 'fact' | 'preference' | 'decision' | 'todo' | 'snippet';
  readonly evidence: unknown;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: ConflictResolution | null;
}

export interface ConflictListFilter {
  readonly open?: boolean | undefined;
  readonly kind?: ConflictRow['kind'] | undefined;
  readonly memoryId?: string | undefined;
  readonly limit?: number | undefined;
}

export function useConflictList(filter: ConflictListFilter = {}) {
  return useQuery({
    queryKey: ['conflict.list', filter],
    queryFn: async () =>
      unwrap(
        await callCommand<readonly ConflictRow[]>('conflict.list', {
          open: filter.open,
          kind: filter.kind,
          memoryId: filter.memoryId,
          limit: filter.limit ?? 200,
        }),
      ),
    // Same load-more reasoning as `useMemoryList`: keep old rows
    // visible while the next page fetches so the browser doesn't
    // lose its scroll anchor.
    placeholderData: keepPreviousData,
  });
}

export interface ResolveConflictArgs {
  readonly id: string;
  readonly resolution: ConflictResolution;
}

export function useResolveConflict(): UseMutationResult<ConflictRow, Error, ResolveConflictArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args) =>
      unwrap(await callCommand<ConflictRow>('conflict.resolve', args)) as ConflictRow,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conflict.list'] });
      // Resolution mutates the underlying memory (supersede) AND
      // changes the open-conflict count surfaced by the overview
      // tile (`system.info`) and audit feed.
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.events'] });
      void qc.invalidateQueries({ queryKey: ['system.info'] });
    },
  });
}

export interface ScanConflictsArgs {
  readonly mode: 'memory' | 'since';
  readonly memoryId?: string;
  readonly since?: string;
}

export function useScanConflicts(): UseMutationResult<
  { readonly scanned: number; readonly opened: readonly ConflictRow[] },
  Error,
  ScanConflictsArgs
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args) =>
      unwrap(
        await callCommand<{ readonly scanned: number; readonly opened: readonly ConflictRow[] }>(
          'conflict.scan',
          args,
        ),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conflict.list'] });
      // A scan can open new conflicts; the overview tile counts
      // them via `system.info`.
      void qc.invalidateQueries({ queryKey: ['system.info'] });
    },
  });
}
