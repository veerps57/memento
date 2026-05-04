// `/` — the landing page.
//
// First-paint goal: tell the user how big the store is, what
// scopes it spans, what was added recently, what looks
// unhealthy — without any clicks. Three rows:
//
//   1. Headline tiles: active count, last write, vector status,
//      open conflicts.
//   2. Status breakdown: one tile per memory status. Sources from
//      `system.info.counts` so the totals are exact (no
//      sample-of-1000 caveat).
//   3. Scope distribution: the 10 most-populated scopes with
//      counts and last-write timestamps. A trailing reconciliation
//      row shows the total of any scopes hidden by the cut so the
//      list visibly sums to the headline `active` count.
//
// Everything is read-only. Mutations live on the per-namespace
// pages (memory, conflicts, config). The landing page is the
// answer to "what's actually in here?" and nothing more.

import { useMemo } from 'react';

import { StatTile } from '../components/StatTile.js';
import { useScopeList, useSystemInfo } from '../hooks/useSystemInfo.js';
import { cn } from '../lib/cn.js';
import { formatScope, relativeTime } from '../lib/format.js';

// `active` is intentionally absent here — the headline tile
// already shows the active count, so repeating it as the first
// chip in this row was redundant. The remaining lifecycle
// statuses describe what's "off the shelf" (archived,
// forgotten, superseded), which is the genuinely new
// information the row contributes.
const STATUS_ORDER = ['archived', 'forgotten', 'superseded'] as const;
const SCOPE_LIMIT = 10;

export function LandingPage(): JSX.Element {
  const info = useSystemInfo();
  const scopes = useScopeList();

  // Last-write across scopes — the system-wide "most recent
  // activity" hint. `system.list_scopes` already orders by
  // count desc; we re-scan for the actual max.
  const lastWriteAt = useMemo(() => {
    const list = scopes.data?.scopes ?? [];
    let max: string | null = null;
    for (const s of list) {
      if (s.lastWriteAt !== null && (max === null || s.lastWriteAt > max)) {
        max = s.lastWriteAt;
      }
    }
    return max;
  }, [scopes.data]);

  const active = info.data?.counts.active;
  // The open-conflict count is now an exact aggregate sourced
  // from `system.info.openConflicts`, not a paged
  // `conflict.list` response. The `1,000+` cap-display this
  // tile used to render is gone; resolving a conflict
  // decrements the value monotonically.
  const conflictCount = info.data?.openConflicts;
  const statusCounts = info.data?.counts;

  // "by scope" only shows the top SCOPE_LIMIT scopes. When more
  // scopes exist, the list does not sum to the headline `active`
  // count — that mismatch is unsettling at a glance. Compute the
  // trailing remainder so the page reconciles.
  const scopeRows = scopes.data?.scopes ?? [];
  const scopeTopRows = scopeRows.slice(0, SCOPE_LIMIT);
  const scopeRemainderCount = scopeRows.slice(SCOPE_LIMIT).length;
  const scopeRemainderTotal = scopeRows.slice(SCOPE_LIMIT).reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="flex flex-col gap-8">
      {/* Page header — stays terminal-flavoured: a prompt-like
          path then the title in plain prose. */}
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">~/overview</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">
          What's in your store today
        </h1>
      </header>

      {/* Row 1: headline tiles. Tile subtexts are gone in favour
          of a single section header so this row reads in the
          same shape as `by status` below. The header already
          carries the "across all scopes" qualifier; repeating it
          per-tile was duplicate ink.
          Vector-retrieval state used to live in this row too
          but reads more naturally as a system-health probe (it
          answers "what kind of search is this store doing?", a
          capability question, not a content summary) — the
          `~/system` page now owns it. */}
      <section aria-label="Headline statistics" className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-widish text-muted">
          across all scopes
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="active memories"
            // Show the precise count rather than the compactNumber
            // form. The previous tile showed `5.0k` as the value
            // and `4,960 total` as the sub — two numbers for the
            // same quantity, which read as a mismatch.
            value={active === undefined ? '—' : active.toLocaleString()}
            accent="on"
          />
          <StatTile
            label="last write"
            value={lastWriteAt === null ? '—' : relativeTime(lastWriteAt)}
          />
          <StatTile
            label="open conflicts"
            value={conflictCount === undefined ? '—' : conflictCount.toLocaleString()}
            accent={conflictCount !== undefined && conflictCount > 0 ? 'conflict' : 'off'}
          />
        </div>
      </section>

      {/* Row 2: status breakdown — exact counts from system.info.
          Replaces the old "by kind (of last 1000)" sample,
          which was confusing at a glance. Subtexts dropped to
          match row 1's shape; absolute counts speak for
          themselves and the share-of-total reads from the row 1
          `active memories` tile by inspection. */}
      <section aria-label="Memories by status" className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-widish text-muted">by status</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {STATUS_ORDER.map((status) => (
            <StatTile
              key={status}
              label={status}
              value={statusCounts ? statusCounts[status] : '—'}
            />
          ))}
        </div>
      </section>

      {/* Row 3: scope distribution */}
      <section aria-label="Scope distribution" className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-widish text-muted">
          by scope{' '}
          {scopeRemainderCount > 0 ? (
            <span className="text-muted/70">(top {SCOPE_LIMIT})</span>
          ) : null}
        </h2>
        <div className="overflow-hidden rounded border border-border">
          {scopes.isLoading ? (
            <RowMessage>loading…</RowMessage>
          ) : scopes.error !== null ? (
            <RowMessage tone="warn">
              failed to load scope distribution: {String(scopes.error)}
            </RowMessage>
          ) : scopeRows.length === 0 ? (
            <RowMessage>no scopes yet — your store is empty.</RowMessage>
          ) : (
            <ul>
              {scopeTopRows.map((entry, idx) => (
                <li
                  key={`${entry.scope.type}-${idx}`}
                  className={cn(
                    'flex items-center gap-3 px-4 py-2',
                    'border-t border-border first:border-t-0',
                  )}
                >
                  <span className="font-mono text-xs text-fg/90 truncate">
                    {formatScope(entry.scope)}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-xs text-muted">
                    {relativeTime(entry.lastWriteAt)}
                  </span>
                  <span className="font-mono text-sm text-fg tabular-nums">
                    {entry.count.toLocaleString()}
                  </span>
                </li>
              ))}
              {/* Reconciliation row: when the top-N cut hides
                  scopes, sum the remainder so the visible list
                  adds back up to the headline `active` count. */}
              {scopeRemainderCount > 0 ? (
                <li
                  key="__remainder"
                  className="flex items-center gap-3 border-t border-border bg-border/20 px-4 py-2"
                >
                  <span className="font-mono text-xs text-muted/80 italic">
                    + {scopeRemainderCount.toLocaleString()} more scope
                    {scopeRemainderCount === 1 ? '' : 's'}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-sm text-muted/80 tabular-nums">
                    {scopeRemainderTotal.toLocaleString()}
                  </span>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function RowMessage({
  children,
  tone = 'muted',
}: {
  readonly children: React.ReactNode;
  readonly tone?: 'muted' | 'warn';
}): JSX.Element {
  return (
    <div
      className={cn('px-4 py-3 font-mono text-xs', tone === 'warn' ? 'text-warn' : 'text-muted')}
    >
      {children}
    </div>
  );
}
