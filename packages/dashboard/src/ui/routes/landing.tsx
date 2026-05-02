// `/` — the landing page (D2).
//
// First-paint goal: tell the user how big the store is, what
// scopes it spans, what was added recently, what looks
// unhealthy — without any clicks. Three rows:
//
//   1. Headline tiles: active count, last write, vector status,
//      open conflicts.
//   2. Kind breakdown: one tile per kind, smaller.
//   3. Scope distribution: the 5-10 most-populated scopes with
//      counts and last-write timestamps.
//
// Everything is read-only. Mutations live on the per-namespace
// pages (memory, conflicts, config). The landing page is the
// answer to "what's actually in here?" and nothing more.

import { useMemo } from 'react';

import { StatTile } from '../components/StatTile.js';
import { useMemorySnapshot } from '../hooks/useMemorySnapshot.js';
import { useOpenConflicts, useScopeList, useSystemInfo } from '../hooks/useSystemInfo.js';
import { cn } from '../lib/cn.js';
import { compactNumber, formatScope, relativeTime } from '../lib/format.js';

const KIND_ORDER = ['fact', 'preference', 'decision', 'todo', 'snippet'] as const;
type KindName = (typeof KIND_ORDER)[number];

export function LandingPage(): JSX.Element {
  const info = useSystemInfo();
  const scopes = useScopeList();
  const conflicts = useOpenConflicts();
  const snapshot = useMemorySnapshot(1000);

  // Aggregate kind counts client-side from the memory snapshot.
  // The first-1000 cap is acceptable for v0 — see
  // useMemorySnapshot.ts for the rationale.
  const kindCounts = useMemo<Record<KindName, number>>(() => {
    const counts: Record<KindName, number> = {
      fact: 0,
      preference: 0,
      decision: 0,
      todo: 0,
      snippet: 0,
    };
    for (const m of snapshot.data ?? []) {
      const k = m.kind.type as KindName;
      if (k in counts) counts[k] += 1;
    }
    return counts;
  }, [snapshot.data]);

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
  const conflictCount = (conflicts.data ?? []).filter((c) => c.resolvedAt === null).length;
  const snapshotCount = snapshot.data?.length ?? 0;
  const kindCountTotal = KIND_ORDER.reduce((sum, k) => sum + kindCounts[k], 0);

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

      {/* Row 1: headline tiles */}
      <section aria-label="Headline statistics" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="active memories"
          value={active === undefined ? '—' : compactNumber(active)}
          sub={active === undefined ? 'loading…' : `${active.toLocaleString()} total`}
          accent="on"
        />
        <StatTile
          label="last write"
          value={lastWriteAt === null ? '—' : relativeTime(lastWriteAt)}
          sub={lastWriteAt === null ? 'no writes yet' : 'across all scopes'}
        />
        <StatTile
          label="vector retrieval"
          value={info.data === undefined ? '—' : info.data.vectorEnabled ? 'on' : 'off'}
          sub={
            info.data === undefined
              ? 'loading…'
              : info.data.vectorEnabled
                ? info.data.embedder.model
                : 'fts only'
          }
          accent={info.data?.vectorEnabled === true ? 'synapse' : 'off'}
        />
        <StatTile
          label="open conflicts"
          value={conflicts.isLoading ? '—' : conflictCount}
          sub={
            conflictCount === 0
              ? 'all clear'
              : conflictCount === 1
                ? '1 to triage'
                : `${conflictCount} to triage`
          }
          accent={conflictCount > 0 ? 'conflict' : 'off'}
        />
      </section>

      {/* Row 2: kind breakdown */}
      <section aria-label="Memories by kind" className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-widish text-muted">
          by kind{' '}
          {snapshotCount === 1000 ? <span className="text-muted/70">(of last 1000)</span> : null}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {KIND_ORDER.map((kind) => (
            <StatTile
              key={kind}
              label={kind}
              value={kindCounts[kind]}
              sub={kindCountTotal === 0 ? '' : `${pct(kindCounts[kind], kindCountTotal)}%`}
            />
          ))}
        </div>
      </section>

      {/* Row 3: scope distribution */}
      <section aria-label="Scope distribution" className="flex flex-col gap-3">
        <h2 className="font-mono text-[11px] uppercase tracking-widish text-muted">by scope</h2>
        <div className="overflow-hidden rounded border border-border">
          {scopes.isLoading ? (
            <RowMessage>loading…</RowMessage>
          ) : scopes.error !== null ? (
            <RowMessage tone="warn">
              failed to load scope distribution: {String(scopes.error)}
            </RowMessage>
          ) : (scopes.data?.scopes.length ?? 0) === 0 ? (
            <RowMessage>no scopes yet — your store is empty.</RowMessage>
          ) : (
            <ul>
              {(scopes.data?.scopes ?? []).slice(0, 10).map((entry, idx) => (
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

function pct(part: number, total: number): string {
  if (total === 0) return '0';
  const v = (part * 100) / total;
  return v < 1 ? '<1' : Math.round(v).toString();
}
