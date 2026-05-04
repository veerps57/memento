// `/audit` — the global activity feed.
//
// `memory.events` has two modes (see ADR-0006 / inputs.ts): when
// `id` is supplied the audit log of that memory is returned; when
// `id` is omitted the cross-memory tail is returned newest-first.
// We use the id-less mode here.
//
// The page is a chronological list with type-pill colour coding,
// optional filtering by event type. Each row that has a `memoryId`
// is a deep-link to the memory detail page.

import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';

import { type MemoryEventRow, useMemoryEvents } from '../hooks/useMemory.js';
import { cn } from '../lib/cn.js';
import { relativeTime } from '../lib/format.js';

const EVENT_TYPES: readonly MemoryEventRow['type'][] = [
  'created',
  'confirmed',
  'updated',
  'superseded',
  'forgotten',
  'restored',
  'archived',
  'reembedded',
];

// Audit-feed pagination: same load-more idiom as the memory list
// page. Engine ceiling for `memory.events` matches the
// `memory.list` ceiling (1000); cursor pagination would be the
// long-run answer.
const LOAD_MORE_PAGE = 100;
const LOAD_MORE_MAX = 1_000;

export function AuditPage(): JSX.Element {
  const [enabled, setEnabled] = useState<Set<MemoryEventRow['type']>>(new Set(EVENT_TYPES));
  const [displayLimit, setDisplayLimit] = useState(LOAD_MORE_PAGE);

  // The filter must always have at least one type selected: a
  // zero-selection state previously masqueraded as "all", which
  // the user couldn't tell apart from a real all-selected state.
  // The `toggle` handler enforces the invariant by no-op-ing the
  // last-remaining-chip click; here we just translate to the
  // wire shape (omit `types` when every chip is on).
  const allSelected = enabled.size === EVENT_TYPES.length;
  const types: readonly MemoryEventRow['type'][] | undefined = allSelected
    ? undefined
    : (Array.from(enabled) as MemoryEventRow['type'][]);

  // Reset paging when the type filter changes — same intent
  // shift as switching status filters on the memory list.
  const filterKey = types === undefined ? 'all' : [...types].sort().join('|');
  const lastFilterKey = useRef(filterKey);
  if (lastFilterKey.current !== filterKey) {
    lastFilterKey.current = filterKey;
    if (displayLimit !== LOAD_MORE_PAGE) setDisplayLimit(LOAD_MORE_PAGE);
  }

  const events = useMemoryEvents({ types, limit: displayLimit });

  const rows = useMemo(() => events.data ?? [], [events.data]);

  const toggle = (t: MemoryEventRow['type']): void => {
    setEnabled((prev) => {
      // Refuse to deselect the last-remaining chip — the wire
      // shape distinguishes "no filter" (every type) from "no
      // types selected" (which would render an empty feed and
      // confuse the user about whether the filter is active).
      if (prev.has(t) && prev.size === 1) return prev;
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">~/audit</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">Activity feed</h1>
        <p className="font-mono text-xs text-muted">
          chronological tail of every memory event — append-only, never edited.
        </p>
      </header>

      {/* Type filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widish text-muted/80">type:</span>
        {EVENT_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => toggle(t)}
            aria-pressed={enabled.has(t)}
            className={cn(
              'rounded border px-2 py-0.5 font-mono text-xs',
              enabled.has(t)
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border text-muted hover:border-fg hover:text-fg',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded border border-border">
        {events.isLoading ? (
          <RowMessage>loading…</RowMessage>
        ) : events.error !== null && events.error !== undefined ? (
          <RowMessage tone="warn">
            failed to load events:{' '}
            {(events.error as { message?: string })?.message ?? String(events.error)}
          </RowMessage>
        ) : rows.length === 0 ? (
          <RowMessage>no events match the selected filters.</RowMessage>
        ) : (
          <ul>
            {rows.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </section>

      {rows.length === displayLimit && displayLimit < LOAD_MORE_MAX ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setDisplayLimit((d) => Math.min(d + LOAD_MORE_PAGE, LOAD_MORE_MAX))}
            disabled={events.isFetching}
            className="rounded border border-border px-3 py-1.5 font-mono text-xs text-fg/90 hover:border-fg disabled:opacity-50"
          >
            {events.isFetching
              ? 'loading…'
              : `load next ${Math.min(LOAD_MORE_PAGE, LOAD_MORE_MAX - displayLimit)}`}
          </button>
        </div>
      ) : displayLimit >= LOAD_MORE_MAX && rows.length >= LOAD_MORE_MAX ? (
        <p className="text-center font-mono text-[11px] text-muted/70">
          showing first {LOAD_MORE_MAX} events — narrow with the type filter for older history
        </p>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { readonly event: MemoryEventRow }): JSX.Element {
  return (
    <li className="flex flex-col gap-1 border-t border-border px-4 py-2 first:border-t-0 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="w-20 shrink-0 font-mono text-[11px] text-muted">
        {relativeTime(event.at)}
      </span>
      <EventTypeBadge type={event.type} />
      <Link
        to="/memory/$id"
        params={{ id: event.memoryId }}
        // White by default, accent on hover. The previous
        // accent-by-default treatment lit up every row in the
        // feed; the type-pill column already carries enough
        // visual weight to anchor the eye.
        className="select-all break-all font-mono text-[11px] text-fg/90 hover:text-accent hover:underline"
      >
        {event.memoryId}
      </Link>
      <span className="font-mono text-[11px] text-muted/80">
        by {event.actor.type}
        {event.actor.id ? `:${event.actor.id}` : ''}
      </span>
    </li>
  );
}

function EventTypeBadge({ type }: { readonly type: MemoryEventRow['type'] }): JSX.Element {
  // Lowercase + neutral white. The audit feed is a dense
  // chronological list; the type label is a readability hint
  // rather than a priority cue, so every row reads at the same
  // visual weight. Filter chips above the feed remain the
  // accent-coloured filter signal.
  return (
    <span
      className={cn(
        'inline-block w-24 shrink-0 rounded border border-border bg-border/30 px-1.5 py-0.5 text-center font-mono text-[11px] text-fg',
      )}
    >
      {type}
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
