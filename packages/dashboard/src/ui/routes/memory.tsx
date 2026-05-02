// `/memory` — the memory browse page (D3 + D6 + D11 + D13).
//
// Three regions:
//
//   1. Search / filter bar at the top. Empty search → list mode
//      (`memory.list`); non-empty → search mode (`memory.search`,
//      ranked by the linear ranker, returns score breakdowns).
//   2. Filter chips below the search bar: status (default
//      `active`), kind, pinned-only, plus a tag picker that
//      pulls from `system.list_tags`.
//   3. Result list. Click a row → navigates to `/memory/:id`.
//
// Sort: lastConfirmedAt desc by default in list mode; ranker
// score desc in search mode.

import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import {
  type MemoryKindName,
  type MemoryRow,
  type MemoryStatus,
  useMemoryList,
  useMemorySearch,
} from '../hooks/useMemory.js';
import { cn } from '../lib/cn.js';
import { effectiveConfidence } from '../lib/decay.js';
import { formatScope, relativeTime } from '../lib/format.js';

const STATUSES: readonly MemoryStatus[] = ['active', 'archived', 'forgotten', 'superseded'];
const KINDS: readonly MemoryKindName[] = ['fact', 'preference', 'decision', 'todo', 'snippet'];

interface BrowseFilters {
  readonly status: MemoryStatus;
  readonly kind: MemoryKindName | null;
  readonly pinnedOnly: boolean;
  readonly query: string;
}

const INITIAL_FILTERS: BrowseFilters = {
  status: 'active',
  kind: null,
  pinnedOnly: false,
  query: '',
};

export function MemoryListPage(): JSX.Element {
  const [filters, setFilters] = useState<BrowseFilters>(INITIAL_FILTERS);
  const trimmedQuery = filters.query.trim();

  const list = useMemoryList({
    status: filters.status,
    kind: filters.kind ?? undefined,
    pinned: filters.pinnedOnly ? true : undefined,
    limit: 200,
  });

  // Search mode kicks in only when the query is non-empty.
  const searchEnabled = trimmedQuery.length > 0;
  const search = useMemorySearch(
    searchEnabled
      ? {
          text: trimmedQuery,
          kinds: filters.kind ? [filters.kind] : undefined,
          includeStatuses: [filters.status],
          limit: 100,
        }
      : null,
  );

  const rows: readonly MemoryRow[] = useMemo(() => {
    if (searchEnabled) {
      const out: readonly MemoryRow[] = (search.data?.results ?? []).map((r) => r.memory);
      return filters.pinnedOnly ? out.filter((m) => m.pinned) : out;
    }
    const sorted = [...(list.data ?? [])].sort((a, b) =>
      a.lastConfirmedAt < b.lastConfirmedAt ? 1 : -1,
    );
    return sorted;
  }, [searchEnabled, search.data, list.data, filters.pinnedOnly]);

  const isLoading = searchEnabled ? search.isLoading : list.isLoading;
  const error = searchEnabled ? search.error : list.error;
  const total = rows.length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">~/memory</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">Browse memories</h1>
      </header>

      {/* Search box. Plain HTML form so Enter submits naturally. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex items-center gap-2 rounded border border-border bg-bg px-3 py-2 focus-within:border-fg">
          <span aria-hidden className="font-mono text-xs text-muted">
            ⌕
          </span>
          <input
            type="search"
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            placeholder="search content / summaries (FTS, vector when enabled)…"
            className="flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-muted/70"
            aria-label="Search memories"
          />
          {filters.query.length > 0 ? (
            <button
              type="button"
              onClick={() => setFilters((f) => ({ ...f, query: '' }))}
              className="font-mono text-xs text-muted hover:text-fg"
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : null}
        </label>

        {/* Filter chips. Status is always set (default active);
            kind is single-select from a closed set; pinned is a
            toggle. */}
        <div className="flex flex-wrap items-center gap-2">
          <ChipGroup label="status">
            {STATUSES.map((s) => (
              <Chip
                key={s}
                active={filters.status === s}
                onClick={() => setFilters((f) => ({ ...f, status: s }))}
              >
                {s}
              </Chip>
            ))}
          </ChipGroup>
          <ChipDivider />
          <ChipGroup label="kind">
            <Chip
              active={filters.kind === null}
              onClick={() => setFilters((f) => ({ ...f, kind: null }))}
            >
              all
            </Chip>
            {KINDS.map((k) => (
              <Chip
                key={k}
                active={filters.kind === k}
                onClick={() => setFilters((f) => ({ ...f, kind: k }))}
              >
                {k}
              </Chip>
            ))}
          </ChipGroup>
          <ChipDivider />
          <Chip
            active={filters.pinnedOnly}
            onClick={() => setFilters((f) => ({ ...f, pinnedOnly: !f.pinnedOnly }))}
          >
            <span aria-hidden>★</span>
            <span className="ml-1">pinned only</span>
          </Chip>
        </div>
      </form>

      {/* Results header — count + mode hint. */}
      <div className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-widish text-muted">
        <span>
          {searchEnabled ? 'search results' : 'recent memories'}{' '}
          <span className="text-muted/70">({total})</span>
        </span>
        {!searchEnabled && total >= 200 ? (
          <span className="text-muted/70">showing first 200 — refine with filters</span>
        ) : null}
      </div>

      {/* Result list */}
      <section className="overflow-hidden rounded border border-border">
        {isLoading ? (
          <RowMessage>loading…</RowMessage>
        ) : error !== null ? (
          <RowMessage tone="warn">
            failed to load: {(error as { message?: string })?.message ?? String(error)}
          </RowMessage>
        ) : rows.length === 0 ? (
          <EmptyState searchEnabled={searchEnabled} status={filters.status} />
        ) : (
          <ul>
            {rows.map((m) => (
              <MemoryRowItem key={m.id} memory={m} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MemoryRowItem({ memory }: { readonly memory: MemoryRow }): JSX.Element {
  const eff = effectiveConfidence(memory);
  return (
    <li className="border-t border-border first:border-t-0">
      <Link
        to="/memory/$id"
        params={{ id: memory.id }}
        className={cn(
          'block px-4 py-3 hover:bg-border/30',
          'flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-3',
        )}
      >
        {/* First line: kind, scope, pinned, tags. */}
        <div className="flex flex-shrink-0 items-baseline gap-2 font-mono text-[11px]">
          <KindBadge kind={memory.kind.type as MemoryKindName} />
          <span className="text-muted">{formatScope(memory.scope)}</span>
          {memory.pinned ? (
            <span aria-label="pinned" className="text-accent">
              ★
            </span>
          ) : null}
          {memory.sensitive ? (
            <span aria-label="sensitive" className="text-warn">
              ⚠
            </span>
          ) : null}
          {memory.tags.length > 0 ? (
            <span className="text-muted/80 truncate">[{memory.tags.join(',')}]</span>
          ) : null}
        </div>
        {/* Second line: content excerpt. */}
        <div className="flex-1 min-w-0 font-sans text-sm text-fg/90">
          <span className="block truncate">
            {formatExcerpt(memory.content, memory.redacted ?? false)}
          </span>
        </div>
        {/* Trailing: time + effective confidence sparkbar. */}
        <div className="flex flex-shrink-0 items-baseline gap-3 font-mono text-[11px] text-muted">
          <ConfidenceMeter value={eff} />
          <span>{relativeTime(memory.lastConfirmedAt)}</span>
        </div>
      </Link>
    </li>
  );
}

function KindBadge({ kind }: { readonly kind: MemoryKindName }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-block rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widish',
        'border border-border bg-border/30',
      )}
      title={`kind: ${kind}`}
    >
      {kind}
    </span>
  );
}

function ConfidenceMeter({ value }: { readonly value: number }): JSX.Element {
  const pct = Math.round(value * 100);
  const tone = value > 0.66 ? 'text-accent' : value > 0.33 ? 'text-fg/80' : 'text-muted/80';
  return (
    <span title={`effective confidence: ${pct}%`} className={cn('font-mono', tone)}>
      {pct}%
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded border px-2 py-0.5 font-mono text-xs',
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border text-muted hover:border-fg hover:text-fg',
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function ChipGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-widish text-muted/80">
        {label}:
      </span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function ChipDivider(): JSX.Element {
  return (
    <span aria-hidden className="hidden text-muted/50 sm:inline">
      ·
    </span>
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

function EmptyState({
  searchEnabled,
  status,
}: {
  readonly searchEnabled: boolean;
  readonly status: MemoryStatus;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-4 py-6 font-mono text-xs text-muted">
      {searchEnabled ? (
        <>
          <p>no matches for that query at this status / kind / pinned filter.</p>
          <p className="text-muted/70">
            tips: try a shorter term; toggle <code>archived</code> / <code>superseded</code>; clear
            kind filter.
          </p>
        </>
      ) : (
        <>
          <p>
            no <span className="text-fg">{status}</span> memories with the current filters.
          </p>
          <p className="text-muted/70">
            try writing one with <code className="text-fg/80">memento memory write</code>, or switch{' '}
            <code className="text-fg/80">status</code> above.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Truncate / collapse content for the row excerpt. Redacted
 * rows display a fixed string so the row stays useful without
 * leaking the redacted content.
 */
function formatExcerpt(content: string | null, redacted: boolean): string {
  if (redacted || content === null) return '(redacted)';
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length === 0 ? '(empty)' : oneLine;
}

// Re-export for App.tsx.
export const MemoryListPageDefault = MemoryListPage;
