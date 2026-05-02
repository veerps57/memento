// TanStack Query setup.
//
// Defaults tuned for a localhost dashboard:
//
//   - Stale time 30s — most views are read-mostly and don't
//     need aggressive refetch. The user can pull-to-refresh
//     from the UI when they want to force one.
//   - Refetch on window focus is on — when the user comes back
//     to the tab from a CLI session, the dashboard reflects
//     any writes the CLI made.
//   - Retry once on transient failures; don't retry on 4xx
//     (the Result envelope already says the call was rejected
//     by the engine for a reason that won't change with a
//     retry).

import { QueryClient } from '@tanstack/react-query';

import type { ApiResult } from './api.js';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (failureCount >= 1) return false;
          // `error` is whatever the queryFn threw; our queryFns
          // throw `ApiErr` on Result failures, network errors
          // surface as exceptions from `fetch`. Retry on
          // network-flavoured failures only.
          const code = (error as { code?: string }).code;
          return code === 'INTERNAL';
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Helper: turn an `ApiResult<T>` into a thrown error on the
 * failure branch, so TanStack Query's success/error split works
 * naturally. Use inside `queryFn`s.
 */
export function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.value;
  // Throwing the structured error means TanStack Query's
  // `error` field carries `code`, `message`, etc. directly.
  throw result.error;
}
