// React-Query hooks for the `config.*` registry surface.
//
// Wire shapes mirror `ConfigEntrySchema` and `ConfigEventSchema`
// from `@psraghuveer/memento-schema`. The dashboard does not
// re-validate on receive — the engine's command output is its
// canonical shape.

import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { callCommand } from '../lib/api.js';
import { unwrap } from '../lib/query.js';

/**
 * One row from `config.list`. The wire fields come from
 * `ConfigEntrySchema`: `key`, `value`, `source`, `setAt`,
 * `setBy`. Mutability is NOT carried on the wire — see
 * `IMMUTABLE_KEYS` in `routes/config.tsx` for the
 * client-side allow-list, with the server's `IMMUTABLE`
 * error code as the canonical fallback.
 */
export interface ConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly source: 'default' | 'startup' | 'runtime';
  readonly setAt: string;
  readonly setBy: { readonly type: string; readonly id?: string } | null;
}

export function useConfigList(prefix?: string) {
  return useQuery({
    queryKey: ['config.list', prefix ?? null],
    queryFn: async () =>
      unwrap(
        await callCommand<readonly ConfigEntry[]>('config.list', {
          prefix,
        }),
      ),
  });
}

/**
 * One row from `config.history`. Maps `ConfigEventSchema` —
 * note the field is `oldValue`, not `previousValue`.
 */
export interface ConfigEvent {
  readonly id: string;
  readonly key: string;
  readonly at: string;
  readonly actor: { readonly type: string; readonly id?: string };
  readonly source: 'default' | 'startup' | 'runtime';
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

export function useConfigHistory(key: string | null, limit = 20) {
  return useQuery({
    queryKey: ['config.history', key, limit],
    enabled: key !== null,
    queryFn: async () =>
      unwrap(
        await callCommand<readonly ConfigEvent[]>('config.history', {
          key,
          limit,
        }),
      ),
  });
}

export interface SetConfigArgs {
  readonly key: string;
  readonly value: unknown;
}

export function useSetConfig(): UseMutationResult<ConfigEntry, Error, SetConfigArgs> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args) =>
      unwrap(await callCommand<ConfigEntry>('config.set', args)) as ConfigEntry,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['config.list'] });
      void qc.invalidateQueries({ queryKey: ['config.history', vars.key] });
    },
  });
}

export function useUnsetConfig(): UseMutationResult<ConfigEntry, Error, { readonly key: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args) =>
      unwrap(await callCommand<ConfigEntry>('config.unset', args)) as ConfigEntry,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['config.list'] });
      void qc.invalidateQueries({ queryKey: ['config.history', vars.key] });
    },
  });
}
