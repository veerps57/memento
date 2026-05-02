// `useMemorySnapshot` — read enough memories to populate the
// landing page's kind-breakdown tile and "last write" stat.
//
// Why a single big read
// ---------------------
//
// `system.info` gives us status counts but not kind counts —
// `memory.list` is the only registered way to get per-kind data.
// For the landing page we want an approximate kind breakdown,
// which we compute client-side from a single `memory.list` call
// at limit=1000 (the registry's hard cap, `memory.list.maxLimit`).
//
// At low-thousand store sizes the read returns the full active
// set and the breakdown is exact. Above that the page reports
// `≥1000 active` and the kind breakdown is "of the most recent
// 1000" — which is what the user actually wants on a landing
// page anyway.
//
// A future paginated aggregation pass (or a `system.kind_counts`
// command added through its own ADR) would produce exact counts
// at scale. Not in v0.

import { useQuery } from '@tanstack/react-query';

import { callCommand } from '../lib/api.js';
import { unwrap } from '../lib/query.js';

interface MemoryView {
  readonly id: string;
  readonly content: string | null;
  readonly redacted?: boolean;
  readonly kind: { readonly type: string };
  readonly status: string;
  readonly pinned: boolean;
  readonly sensitive: boolean;
  readonly createdAt: string;
  readonly lastConfirmedAt: string;
  readonly storedConfidence: number;
  readonly tags: readonly string[];
}

export function useMemorySnapshot(limit = 1000) {
  return useQuery({
    queryKey: ['memory.list', { status: 'active', limit }],
    queryFn: async () =>
      unwrap(
        await callCommand<readonly MemoryView[]>('memory.list', {
          status: 'active',
          limit,
        }),
      ),
  });
}
