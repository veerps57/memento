// React-Query hooks for `pack.*` reads and mutations.
//
// The dashboard's Packs tab consumes:
//
//   - `pack.list`       — what's installed today (id, version,
//                          scope, count). Background-refreshed
//                          on focus.
//   - `pack.install`    — install a bundled id, file, or URL.
//                          Mutation; invalidates pack.list and
//                          memory-shaped queries on success.
//   - `pack.uninstall`  — forget every memory carrying a given
//                          `pack:<id>:<version>` tag. Mutation;
//                          invalidates the same queries as install
//                          since both reshape the active set.
//
// `pack.preview` is intentionally not pre-fetched; the install
// dialog runs it lazily when the user picks a source so the API
// surface is not hit unprovoked. `pack.export` is a CLI-side
// authoring tool and stays absent here; the dashboard does not
// write packs.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callCommand } from '../lib/api.js';
import { unwrap } from '../lib/query.js';

export interface InstalledPack {
  readonly id: string;
  readonly version: string;
  readonly scope: { readonly type: string; readonly [k: string]: unknown };
  readonly count: number;
}

export interface PackInstallSource {
  readonly type: 'bundled' | 'file' | 'url';
  readonly id?: string;
  readonly version?: string;
  readonly path?: string;
  readonly url?: string;
}

export interface PackInstallResult {
  readonly state: 'fresh' | 'idempotent' | 'drift';
  readonly packId: string;
  readonly version: string;
  readonly written: readonly string[];
  readonly itemCount: number;
  readonly alreadyInstalled: boolean;
  readonly warnings: readonly string[];
}

export interface PackUninstallResult {
  readonly dryRun: boolean;
  readonly matched: number;
  readonly applied: number;
  readonly packId: string;
  readonly version: string | null;
}

export function useInstalledPacks() {
  return useQuery({
    queryKey: ['pack.list'],
    queryFn: async () =>
      unwrap(await callCommand<{ readonly packs: readonly InstalledPack[] }>('pack.list')),
  });
}

export function useInstallPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { source: PackInstallSource; dryRun?: boolean }) =>
      unwrap(
        await callCommand<PackInstallResult>('pack.install', {
          source: input.source,
          dryRun: input.dryRun ?? false,
        }),
      ),
    onSuccess: () => {
      // pack.install reshapes the active memory set. Invalidate
      // every dependent query so the UI refreshes without a full
      // page reload.
      void qc.invalidateQueries({ queryKey: ['pack.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['system.info'] });
      void qc.invalidateQueries({ queryKey: ['system.list_scopes'] });
    },
  });
}

export function useUninstallPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      version?: string;
      allVersions?: boolean;
      dryRun?: boolean;
    }) =>
      unwrap(
        await callCommand<PackUninstallResult>('pack.uninstall', {
          id: input.id,
          ...(input.allVersions
            ? { allVersions: true }
            : input.version !== undefined
              ? { version: input.version }
              : {}),
          dryRun: input.dryRun ?? false,
          confirm: true,
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pack.list'] });
      void qc.invalidateQueries({ queryKey: ['memory.list'] });
      void qc.invalidateQueries({ queryKey: ['system.info'] });
      void qc.invalidateQueries({ queryKey: ['system.list_scopes'] });
    },
  });
}
