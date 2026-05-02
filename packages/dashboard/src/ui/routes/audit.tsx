// `/audit` — the global activity feed (D7 + D8).
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
import { useMemo, useState } from 'react';

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

export function AuditPage(): JSX.Element {
  const [enabled, setEnabled] = useState<Set<MemoryEventRow['type']>>(new Set(EVENT_TYPES));

  // When the user un-checks every type we flip to "no filter"
  // so the feed isn't empty — communicates intent better.
  const types: readonly MemoryEventRow['type'][] | undefined =
    enabled.size === 0 || enabled.size === EVENT_TYPES.length
      ? undefined
      : (Array.from(enabled) as MemoryEventRow['type'][]);

  const events = useMemoryEvents({ types, limit: 200 });

  const rows = useMemo(() => events.data ?? [], [events.data]);

  const toggle = (t: MemoryEventRow['type']): void => {
    setEnabled((prev) => {
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
          <RowMessage>
            {enabled.size === 0 ? 'select at least one event type.' : 'no events yet.'}
          </RowMessage>
        ) : (
          <ul>
            {rows.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </section>
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
        className="select-all font-mono text-[11px] text-accent hover:underline break-all"
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
  const tone =
    type === 'forgotten' || type === 'archived'
      ? 'text-warn'
      : type === 'created' || type === 'restored' || type === 'reembedded'
        ? 'text-accent'
        : 'text-fg/80';
  return (
    <span
      className={cn(
        'inline-block w-24 shrink-0 rounded border border-border bg-border/30 px-1.5 py-0.5 text-center font-mono text-[11px] uppercase tracking-widish',
        tone,
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
