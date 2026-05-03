// React-Query hooks for system-level reads.
//
// `system.info` answers "what version, what db, vector on, how
// many memories by status" in one call. Used by:
//
//   - Status bar (continuously, refetched on focus)
//   - Landing page stat tiles (one of several sources)
//   - System tab (the canonical detail view)
//
// `system.list_scopes` and `list_conflicts` are sibling
// landing-page sources; their hooks live here too so the data
// layer is centralised.

import { useQuery } from '@tanstack/react-query';

import { callCommand } from '../lib/api.js';
import { unwrap } from '../lib/query.js';

export interface SystemInfo {
  readonly version: string;
  readonly schemaVersion: number;
  readonly dbPath: string | null;
  readonly vectorEnabled: boolean;
  readonly embedder: {
    readonly configured: boolean;
    readonly model: string;
    readonly dimension: number;
  };
  readonly counts: {
    readonly active: number;
    readonly archived: number;
    readonly forgotten: number;
    readonly superseded: number;
  };
  /**
   * Single-user identity. `preferredName` is the value of the
   * `user.preferredName` config; the dashboard wordmark uses it
   * to render `<name>@memento_` (a shell-prompt style cue),
   * falling back to `memento_` when null.
   */
  readonly user: {
    readonly preferredName: string | null;
  };
}

export interface ScopeSummary {
  readonly scope: { readonly type: string; readonly [k: string]: unknown };
  readonly count: number;
  readonly lastWriteAt: string | null;
}

export interface ConflictSummary {
  readonly id: string;
  readonly newMemoryId: string;
  readonly conflictingMemoryId: string;
  readonly kind: string;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

export function useSystemInfo() {
  return useQuery({
    queryKey: ['system.info'],
    queryFn: async () => unwrap(await callCommand<SystemInfo>('system.info')),
  });
}

export function useScopeList() {
  return useQuery({
    queryKey: ['system.list_scopes'],
    queryFn: async () =>
      unwrap(await callCommand<{ readonly scopes: readonly ScopeSummary[] }>('system.list_scopes')),
  });
}

export function useOpenConflicts() {
  return useQuery({
    queryKey: ['conflict.list', 'open'],
    queryFn: async () =>
      unwrap(
        // `conflict.list` accepts `open: boolean` (true → open
        // only, false → resolved only). The earlier draft of
        // this hook passed `{ status: 'open' }`, which Zod's
        // `.strict()` parser rejected — silently, because the
        // landing page treats an empty array as "all clear."
        await callCommand<readonly ConflictSummary[]>('conflict.list', {
          open: true,
          limit: 1000,
        }),
      ),
  });
}
