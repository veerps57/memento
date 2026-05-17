// `/memory` — the memory browse page.
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
import { useMemo, useRef, useState } from 'react';

import {
  type EmbeddingStatus,
  type MemoryKindName,
  type MemoryRow,
  type MemoryStatus,
  useEmbeddingRebuild,
  useMemoryList,
  useMemorySearch,
} from '../hooks/useMemory.js';
import { cn } from '../lib/cn.js';
import { effectiveConfidence } from '../lib/decay.js';
import { formatScope, relativeTime } from '../lib/format.js';

const STATUSES: readonly MemoryStatus[] = ['active', 'archived', 'forgotten', 'superseded'];
const KINDS: readonly MemoryKindName[] = ['fact', 'preference', 'decision', 'todo', 'snippet'];

interface BrowseFilters {
  /**
   * Active status filter as a Set. Same multi-select model as
   * `kinds`. Defaults to `{ active }` so the page opens to the
   * "what's currently in the store" view — toggling another
   * status (`archived`, `forgotten`, `superseded`) widens the
   * selection. Selecting every status individually collapses
   * back to "all" so the displayed selection stays honest.
   */
  readonly statuses: ReadonlySet<MemoryStatus>;
  /**
   * Active kind filter as a Set so the user can multi-select. An
   * empty Set means "all kinds" — shown as the `all` chip being
   * active. The set is converted on the wire (memory.list takes
   * a single optional `kind`; multi-selects are filtered
   * client-side from the engine response — see the rows memo).
   */
  readonly kinds: ReadonlySet<MemoryKindName>;
  readonly pinnedOnly: boolean;
  /**
   * When true, narrow visible rows to those whose stored
   * embedding mismatches the configured embedder
   * (`embeddingStatus === 'stale'`). The wire-level filter does
   * not exist on `memory.list`; narrowing is client-side, so
   * the count reflects "stale in the current page" rather than
   * a global tally. The rebuild banner uses the same predicate.
   */
  readonly staleOnly: boolean;
  readonly query: string;
}

const INITIAL_FILTERS: BrowseFilters = {
  statuses: new Set(['active']),
  kinds: new Set(),
  pinnedOnly: false,
  staleOnly: false,
  query: '',
};

function toggleSet<T>(prev: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// "Load more" page size. Each click bumps the engine `limit`
// passed to `memory.list` by this many rows, up to LOAD_MORE_MAX
// (the engine's `memory.list.maxLimit` default). The dashboard
// is a triage surface, not a full browser — beyond LOAD_MORE_MAX
// the user is meant to refine filters rather than scroll
// indefinitely. Cursor-based pagination would be the right
// long-run answer; this is the pragmatic incremental fix.
const LOAD_MORE_PAGE = 100;
const LOAD_MORE_MAX = 1_000;

export function MemoryListPage(): JSX.Element {
  const [filters, setFilters] = useState<BrowseFilters>(INITIAL_FILTERS);
  const [displayLimit, setDisplayLimit] = useState(LOAD_MORE_PAGE);
  const trimmedQuery = filters.query.trim();

  // Sorted kind-set key for memoisation + reset detection.
  const kindKey = useMemo(() => [...filters.kinds].sort().join(','), [filters.kinds]);
  const statusKey = useMemo(() => [...filters.statuses].sort().join(','), [filters.statuses]);

  // Reset the page size when the filter / search changes — the
  // user's intent has shifted and the previous "I have loaded
  // 600 archived" doesn't carry over to "loading active".
  const filterKey = `${statusKey}|${kindKey}|${filters.pinnedOnly ? '1' : '0'}|${filters.staleOnly ? '1' : '0'}|${trimmedQuery}`;
  const lastFilterKey = useRef(filterKey);
  if (lastFilterKey.current !== filterKey) {
    lastFilterKey.current = filterKey;
    if (displayLimit !== LOAD_MORE_PAGE) setDisplayLimit(LOAD_MORE_PAGE);
  }

  // The engine `memory.list` input takes a single optional
  // `status` and a single optional `kind`. To support multi-select
  // we send a wire-level filter only when exactly one chip is
  // selected (engine indexes do the work); for 2+ selections we
  // fetch unfiltered for that axis and narrow client-side. With
  // zero selections we pass nothing.
  const wireStatus: MemoryStatus | undefined =
    filters.statuses.size === 1 ? ([...filters.statuses][0] as MemoryStatus) : undefined;
  const wireKind: MemoryKindName | undefined =
    filters.kinds.size === 1 ? ([...filters.kinds][0] as MemoryKindName) : undefined;
  const list = useMemoryList({
    status: wireStatus,
    kind: wireKind,
    pinned: filters.pinnedOnly ? true : undefined,
    limit: displayLimit,
  });

  // Search mode kicks in only when the query is non-empty.
  const searchEnabled = trimmedQuery.length > 0;
  const search = useMemorySearch(
    searchEnabled
      ? {
          text: trimmedQuery,
          kinds: filters.kinds.size > 0 ? ([...filters.kinds] as MemoryKindName[]) : undefined,
          includeStatuses:
            filters.statuses.size > 0 ? ([...filters.statuses] as MemoryStatus[]) : undefined,
          limit: 100,
        }
      : null,
  );

  const rows: readonly MemoryRow[] = useMemo(() => {
    if (searchEnabled) {
      const out: readonly MemoryRow[] = (search.data?.results ?? []).map((r) => r.memory);
      const afterPinned = filters.pinnedOnly ? out.filter((m) => m.pinned) : out;
      return filters.staleOnly
        ? afterPinned.filter((m) => m.embeddingStatus === 'stale')
        : afterPinned;
    }
    const base = list.data ?? [];
    // Apply client-side narrowing for any axis where the user
    // has picked 2+ values (the engine couldn't filter for the
    // union — see the wire* computations above). When 0 or 1
    // value is selected the engine already did the filter, so
    // pass-through. The `staleOnly` axis has no engine-side
    // equivalent — `memory.list` does not accept an
    // `embeddingStatus` filter — so it always narrows
    // client-side from whatever the engine returned.
    const narrowedByStatus =
      filters.statuses.size > 1
        ? base.filter((m) => filters.statuses.has(m.status as MemoryStatus))
        : base;
    const narrowedByKind =
      filters.kinds.size > 1
        ? narrowedByStatus.filter((m) => filters.kinds.has(m.kind.type as MemoryKindName))
        : narrowedByStatus;
    const narrowedByStale = filters.staleOnly
      ? narrowedByKind.filter((m) => m.embeddingStatus === 'stale')
      : narrowedByKind;
    const sorted = [...narrowedByStale].sort((a, b) =>
      a.lastConfirmedAt < b.lastConfirmedAt ? 1 : -1,
    );
    return sorted;
  }, [
    searchEnabled,
    search.data,
    list.data,
    filters.pinnedOnly,
    filters.kinds,
    filters.statuses,
    filters.staleOnly,
  ]);

  // Count of rows in the current view that have stale
  // embeddings — drives both the "Stale only" filter chip's
  // dim-when-zero state and the rebuild banner. Computed
  // off `rows` so it respects every other active filter (a
  // user viewing only `decision`s wouldn't expect the count
  // to spike to "all stale across all kinds").
  const staleCount = useMemo(
    () => rows.filter((m) => m.embeddingStatus === 'stale').length,
    [rows],
  );

  const rebuild = useEmbeddingRebuild();

  const isLoading = searchEnabled ? search.isLoading : list.isLoading;
  const error = searchEnabled ? search.error : list.error;

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

        {/* Filter chips. Status and kind are both multi-select
            (Set<T> behind the scenes). Pinned is a single toggle.
            Per-axis: clicking a chip toggles it in the set;
            clicking the same chip again removes it. Selecting
            every chip individually collapses back to the empty
            set (= "all") so the filter row stays honest. */}
        <div className="flex flex-wrap items-center gap-2">
          <ChipGroup label="status">
            {/* Refuse to deselect the last-remaining status:
                a zero-selection state on a single axis would
                masquerade as "all" without an `all` chip to
                explain it (kinds has its own `all` chip; status
                doesn't because the four statuses always cover
                the universe). */}
            {STATUSES.map((s) => (
              <Chip
                key={s}
                active={filters.statuses.has(s)}
                onClick={() =>
                  setFilters((f) => {
                    if (f.statuses.has(s) && f.statuses.size === 1) return f;
                    return { ...f, statuses: toggleSet(f.statuses, s) };
                  })
                }
              >
                {s}
              </Chip>
            ))}
          </ChipGroup>
          <ChipDivider />
          <ChipGroup label="kind">
            <Chip
              active={filters.kinds.size === 0}
              onClick={() => setFilters((f) => ({ ...f, kinds: new Set<MemoryKindName>() }))}
            >
              all
            </Chip>
            {KINDS.map((k) => (
              <Chip
                key={k}
                active={filters.kinds.has(k)}
                onClick={() =>
                  setFilters((f) => {
                    const next = toggleSet(f.kinds, k);
                    return {
                      ...f,
                      kinds: next.size === KINDS.length ? new Set<MemoryKindName>() : next,
                    };
                  })
                }
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
          <Chip
            active={filters.staleOnly}
            onClick={() => setFilters((f) => ({ ...f, staleOnly: !f.staleOnly }))}
          >
            <span aria-hidden>↺</span>
            <span className="ml-1">stale embeddings only</span>
          </Chip>
        </div>
      </form>

      {/* Rebuild banner. Surfaces when at least one row in the
          current view has a stale embedding — i.e. the stored
          vector's model / dim mismatch the configured embedder.
          The CTA calls `embedding.rebuild` which is batched and
          idempotent server-side; on success the cache invalidator
          inside the hook refreshes `memory.list` / `memory.search`
          so the banner re-evaluates and dismisses itself when no
          more stale rows are visible. */}
      {staleCount > 0 ? (
        <div className="flex flex-col gap-2 rounded border border-warn/40 bg-warn/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="font-mono text-[12px] text-fg/90">
            <span aria-hidden className="mr-2 text-warn">
              ↺
            </span>
            {staleCount === 1
              ? '1 memory in this view has a stale embedding'
              : `${staleCount} memories in this view have stale embeddings`}
            <span className="ml-1 text-muted">
              (model / dimension mismatch the configured embedder)
            </span>
          </div>
          <button
            type="button"
            onClick={() => rebuild.mutate({})}
            disabled={rebuild.isPending}
            className="self-start rounded border border-warn/60 bg-warn/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widish text-fg hover:border-warn disabled:opacity-50 sm:self-auto"
          >
            {rebuild.isPending ? 'rebuilding…' : 'rebuild stale embeddings'}
          </button>
        </div>
      ) : null}
      {rebuild.isSuccess && rebuild.data !== undefined ? (
        <div className="rounded border border-border bg-border/20 px-3 py-1.5 font-mono text-[11px] text-fg/80">
          <span aria-hidden className="mr-2 text-accent">
            ✓
          </span>
          rebuilt {rebuild.data.embedded.length} memor
          {rebuild.data.embedded.length === 1 ? 'y' : 'ies'}; scanned {rebuild.data.scanned},
          skipped {rebuild.data.skipped.length}.
          {rebuild.data.skipped.length > 0 ? (
            <span className="ml-1 text-muted">
              (skip reasons: {[...new Set(rebuild.data.skipped.map((s) => s.reason))].join(', ')})
            </span>
          ) : null}
        </div>
      ) : null}
      {rebuild.isError ? (
        <div className="rounded border border-warn/60 bg-warn/10 px-3 py-1.5 font-mono text-[11px] text-fg">
          <span aria-hidden className="mr-2 text-warn">
            ✕
          </span>
          rebuild failed:{' '}
          {(rebuild.error as { message?: string })?.message ?? String(rebuild.error)}
        </div>
      ) : null}

      {/* Results meta row — only the cap hint, no row count. The
          count was misleading because the page mixes engine-paged
          rows with client-side narrowing (multi-select status /
          kind), so the visible `(N)` rarely matched the user's
          mental model of "how many active memories do I have"
          (that lives on the overview tiles instead). */}
      {!searchEnabled && displayLimit >= LOAD_MORE_MAX && rows.length >= LOAD_MORE_MAX ? (
        <p className="font-mono text-[11px] uppercase tracking-widish text-muted/70">
          showing first {LOAD_MORE_MAX} — refine with filters
        </p>
      ) : null}

      {/* Result list */}
      <section className="overflow-hidden rounded border border-border">
        {isLoading ? (
          <RowMessage>loading…</RowMessage>
        ) : error !== null ? (
          <RowMessage tone="warn">
            failed to load: {(error as { message?: string })?.message ?? String(error)}
          </RowMessage>
        ) : rows.length === 0 ? (
          <EmptyState searchEnabled={searchEnabled} statuses={filters.statuses} />
        ) : (
          <ul>
            {rows.map((m) => (
              <MemoryRowItem key={m.id} memory={m} />
            ))}
          </ul>
        )}
      </section>

      {/* Load-more affordance. Hidden in search mode (FTS+vector
          already ranks across the whole corpus and a separate
          paginator would be confusing). The button compares
          against the engine response length rather than `total`
          (which may be smaller after the client-side multi-kind
          filter) so multi-kind selections still let the user
          paginate. The button is disabled mid-fetch and at the
          engine's hard ceiling. */}
      {!searchEnabled &&
      (list.data?.length ?? 0) === displayLimit &&
      displayLimit < LOAD_MORE_MAX ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setDisplayLimit((d) => Math.min(d + LOAD_MORE_PAGE, LOAD_MORE_MAX))}
            disabled={list.isFetching}
            className="rounded border border-border px-3 py-1.5 font-mono text-xs text-fg/90 hover:border-fg disabled:opacity-50"
          >
            {list.isFetching
              ? 'loading…'
              : `load next ${Math.min(LOAD_MORE_PAGE, LOAD_MORE_MAX - displayLimit)}`}
          </button>
        </div>
      ) : null}
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
        {/* First line: kind, scope, pinned, tags, embedding state. */}
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
          {memory.embeddingStatus !== undefined && memory.embeddingStatus !== 'present' ? (
            <EmbeddingBadge status={memory.embeddingStatus} />
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

/**
 * Surface the row's embedding state when it's anything other
 * than `'present'`. `'present'` is the silent default — calling
 * it out on every row would crowd the line.
 *
 * Tones (one per status):
 *
 * - `stale`    — warn (yellow). The row has an embedding but
 *                the configured embedder changed; the vector
 *                arm of search is skipping it until
 *                `embedding.rebuild` re-embeds.
 * - `pending`  — muted (grey). Embedder is on but hasn't caught
 *                up yet. Usually milliseconds after a write.
 * - `disabled` — muted (grey). `retrieval.vector.enabled` is
 *                off — FTS only.
 *
 * Title attributes carry the long-form explanation so a hover
 * teaches the user what the badge means without a click-through.
 */
function EmbeddingBadge({ status }: { readonly status: EmbeddingStatus }): JSX.Element {
  if (status === 'stale') {
    return (
      <span
        className="inline-block rounded border border-warn/60 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn"
        title="Stale: stored embedding's model / dimension mismatches the configured embedder. Run `embedding rebuild` to re-embed."
      >
        stale
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span
        className="inline-block rounded border border-border bg-border/30 px-1.5 py-0.5 text-[10px] text-muted"
        title="Pending: vector retrieval is enabled but the embedder hasn't caught up yet (usually milliseconds after a write)."
      >
        pending
      </span>
    );
  }
  if (status === 'disabled') {
    return (
      <span
        className="inline-block rounded border border-border bg-border/30 px-1.5 py-0.5 text-[10px] text-muted"
        title="Disabled: `retrieval.vector.enabled` is off — only the FTS arm of search is active."
      >
        no vec
      </span>
    );
  }
  // 'present' renders nothing (the silent default — see the
  // caller's `!== 'present'` guard).
  return <span aria-hidden />;
}

function KindBadge({ kind }: { readonly kind: MemoryKindName }): JSX.Element {
  // Lowercase, no letter-spacing — matches the surrounding
  // mono prose tone. The previous uppercase + tracked treatment
  // made the pill compete visually with content.
  return (
    <span
      className={cn(
        'inline-block rounded px-1.5 py-0.5 text-[11px]',
        'border border-border bg-border/30 text-fg/80',
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
  statuses,
}: {
  readonly searchEnabled: boolean;
  readonly statuses: ReadonlySet<MemoryStatus>;
}): JSX.Element {
  // Render the active status set as a list. Empty set means
  // "all statuses" — describe that explicitly so the empty
  // message doesn't read as a blank filter.
  const statusList = statuses.size === 0 ? 'any' : [...statuses].join(' / ');
  return (
    <div className="flex flex-col gap-3 px-4 py-6 font-mono text-xs text-muted">
      {searchEnabled ? (
        <>
          <p>no matches for that query at this status / kind / pinned filter.</p>
          <p className="text-muted/70">
            tips: try a shorter term; widen the <code>status</code> selection; clear the kind
            filter.
          </p>
        </>
      ) : (
        <>
          <p>
            no <span className="text-fg">{statusList}</span> memories with the current filters.
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
