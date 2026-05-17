// `/memory/$id` — full memory detail.
//
// Sections, top → bottom:
//
//   1. Header: kind / scope / pinned / sensitive badges, id (copy
//      button), action row (pin toggle, confirm, forget, back).
//   2. Body: the content (with sensitive reveal toggle), summary
//      if present, tags as a list.
//   3. Lineage: supersedes / supersededBy links rendered as a
//      tiny vertical chain so the user can jump up or down.
//   4. Audit timeline: every event for this memory (`memory.events`
//      with id), oldest first. Each event renders type-specific
//      payload metadata.
//   5. Provenance: created at, last confirmed at, stored vs.
//      effective confidence (with a brief explanation), schema
//      version.
//
// All mutations confirm via the browser's native confirm() for v0
// — the modal flavour can come later without touching the
// underlying mutation hooks.

import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import {
  type EmbeddingStatus,
  type MemoryEventRow,
  type MemoryRow,
  useConfirmMemory,
  useEmbeddingRebuild,
  useForgetMemory,
  useMemoryEvents,
  useMemoryRead,
  useUpdateMemory,
} from '../hooks/useMemory.js';
import { useSystemInfo } from '../hooks/useSystemInfo.js';
import { cn } from '../lib/cn.js';
import { effectiveConfidence } from '../lib/decay.js';
import { formatScope, relativeTime } from '../lib/format.js';

export function MemoryDetailPage(): JSX.Element {
  const { id } = useParams({ from: '/memory/$id' });
  const navigate = useNavigate();
  const memory = useMemoryRead(id);
  const events = useMemoryEvents({ id, limit: 200 });
  const update = useUpdateMemory();
  const forget = useForgetMemory();
  const confirm = useConfirmMemory();
  const rebuild = useEmbeddingRebuild();
  const systemInfo = useSystemInfo();
  const [reveal, setReveal] = useState(false);

  if (memory.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p className="font-mono text-xs text-muted">loading…</p>
      </div>
    );
  }
  if (memory.error !== null && memory.error !== undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p className="font-mono text-xs text-warn">
          failed to load memory:{' '}
          {(memory.error as { message?: string })?.message ?? String(memory.error)}
        </p>
      </div>
    );
  }
  const m = memory.data;
  if (m === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p className="font-mono text-xs text-muted">not found.</p>
      </div>
    );
  }

  const eff = effectiveConfidence(m);
  const isPinned = m.pinned;
  const isRedacted = m.redacted === true || m.content === null;
  const showReveal = isRedacted && reveal;

  const handlePinToggle = (): void => {
    update.mutate({ id: m.id, patch: { pinned: !isPinned } });
  };
  const handleConfirm = (): void => {
    confirm.mutate({ id: m.id });
  };
  const handleForget = (): void => {
    if (
      !window.confirm(
        'Forget this memory? It will move to status=forgotten and stop appearing in active reads. Recoverable via memento memory restore.',
      )
    ) {
      return;
    }
    forget.mutate(
      { id: m.id, reason: null },
      {
        onSuccess: () => {
          void navigate({ to: '/memory' });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      {/* Header */}
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-2 font-mono text-[11px]">
          <span className="text-muted">~/memory/</span>
          <span className="select-all text-fg/90">{m.id}</span>
          <CopyButton text={m.id} />
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <KindBadge kind={m.kind.type} />
          <ScopePill scope={m.scope} />
          <StatusPill status={m.status} />
          {m.pinned ? <Pill tone="accent">★ pinned</Pill> : null}
          {m.sensitive ? <Pill tone="warn">⚠ sensitive</Pill> : null}
          {m.embeddingStatus !== undefined && m.embeddingStatus !== 'present' ? (
            <EmbeddingPill
              status={m.embeddingStatus}
              stored={
                m.embedding !== null
                  ? { model: m.embedding.model, dimension: m.embedding.dimension }
                  : null
              }
              configured={
                systemInfo.data?.embedder.configured === true
                  ? {
                      model: systemInfo.data.embedder.model,
                      dimension: systemInfo.data.embedder.dimension,
                    }
                  : null
              }
            />
          ) : null}
        </div>
        {/* Action row */}
        <div className="flex flex-wrap gap-2">
          <ActionButton
            onClick={handlePinToggle}
            pending={update.isPending}
            label={isPinned ? 'unpin' : 'pin'}
            title={isPinned ? 'Unpin (memory.update)' : 'Pin (memory.update)'}
          />
          <ActionButton
            onClick={handleConfirm}
            pending={confirm.isPending}
            label="confirm"
            title="Reset decay clock (memory.confirm)"
          />
          <ActionButton
            onClick={handleForget}
            pending={forget.isPending}
            label="forget"
            disabled={m.status === 'forgotten'}
            title={
              m.status === 'forgotten'
                ? 'Already forgotten'
                : 'Move to status=forgotten (memory.forget)'
            }
          />
          {m.embeddingStatus === 'stale' ? (
            <ActionButton
              onClick={() => rebuild.mutate({})}
              pending={rebuild.isPending}
              label="rebuild"
              title="Re-embed this memory (and any other stale rows) against the configured embedder (embedding.rebuild)"
            />
          ) : null}
        </div>
        {(update.error ?? forget.error ?? confirm.error ?? rebuild.error) ? (
          <p className="font-mono text-xs text-warn">
            action failed:{' '}
            {(update.error ?? forget.error ?? confirm.error ?? rebuild.error) instanceof Error
              ? ((update.error ?? forget.error ?? confirm.error ?? rebuild.error) as Error).message
              : 'unknown error'}
          </p>
        ) : null}
      </header>

      {/* Body */}
      <section
        aria-label="Memory content"
        className="flex flex-col gap-3 rounded border border-border p-4"
      >
        <SectionLabel>content</SectionLabel>
        {isRedacted && !reveal ? (
          <div className="flex flex-col gap-2">
            <pre className="whitespace-pre-wrap font-mono text-sm text-muted">
              (redacted — sensitive=true and `privacy.redactSensitiveSnippets` is on)
            </pre>
            <button
              type="button"
              onClick={() => setReveal(true)}
              className="self-start font-mono text-xs text-accent hover:underline"
            >
              reveal once
            </button>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-sm text-fg">
            {showReveal
              ? '(revealed locally only — content stays redacted on the wire)'
              : m.content}
          </pre>
        )}
        {m.summary !== null ? (
          <div className="flex flex-col gap-1">
            <SectionLabel>summary</SectionLabel>
            <p className="font-sans text-sm text-fg/90">{m.summary}</p>
          </div>
        ) : null}
        {m.tags.length > 0 ? (
          <div className="flex flex-col gap-1">
            <SectionLabel>tags</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {m.tags.map((t) => (
                <span
                  key={t}
                  className="rounded border border-border bg-border/30 px-1.5 py-0.5 font-mono text-[11px] text-fg/80"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Lineage */}
      {(m.supersedes ?? m.supersededBy) ? (
        <section
          aria-label="Supersession chain"
          className="flex flex-col gap-2 rounded border border-border p-4"
        >
          <SectionLabel>lineage</SectionLabel>
          <div className="flex flex-col gap-1.5 font-mono text-xs">
            {m.supersedes !== null ? (
              <ChainRow direction="up" id={m.supersedes} label="supersedes" />
            ) : null}
            <div className="text-fg/90">
              <span aria-hidden>● </span>this memory
            </div>
            {m.supersededBy !== null ? (
              <ChainRow direction="down" id={m.supersededBy} label="superseded by" />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Provenance */}
      <section
        aria-label="Provenance"
        className="grid grid-cols-1 gap-2 rounded border border-border p-4 sm:grid-cols-2"
      >
        <SectionLabel>provenance</SectionLabel>
        <KV label="created" value={`${relativeTime(m.createdAt)} (${m.createdAt})`} />
        <KV
          label="last confirmed"
          value={`${relativeTime(m.lastConfirmedAt)} (${m.lastConfirmedAt})`}
        />
        <KV label="stored confidence" value={`${(m.storedConfidence * 100).toFixed(1)}%`} />
        <KV
          label="effective"
          value={`${(eff * 100).toFixed(1)}% — decay-adjusted from last confirm`}
        />
        <KV label="schema version" value={String(m.schemaVersion)} />
        <KV label="owner" value={`${m.owner.type}:${m.owner.id}`} />
      </section>

      {/* Audit timeline */}
      <section aria-label="Audit timeline" className="flex flex-col gap-2">
        <SectionLabel>audit timeline</SectionLabel>
        <div className="overflow-hidden rounded border border-border">
          {events.isLoading ? (
            <RowMessage>loading…</RowMessage>
          ) : events.error !== null ? (
            <RowMessage tone="warn">
              failed to load events:{' '}
              {(events.error as { message?: string })?.message ?? String(events.error)}
            </RowMessage>
          ) : (events.data ?? []).length === 0 ? (
            <RowMessage>no events recorded.</RowMessage>
          ) : (
            <ul>
              {(events.data ?? []).map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link to="/memory" className="self-start font-mono text-xs text-muted hover:text-fg">
      ← back to ~/memory
    </Link>
  );
}

function CopyButton({ text }: { readonly text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="font-mono text-[11px] text-muted hover:text-fg"
      onClick={() => {
        // `navigator.clipboard` is missing in Safari over insecure
        // contexts; the dashboard binds to localhost so this is
        // safe in practice.
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

function KindBadge({ kind }: { readonly kind: string }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-block rounded px-1.5 py-0.5 font-mono text-[11px]',
        'border border-border bg-border/30 text-fg/80',
      )}
    >
      {kind}
    </span>
  );
}

function ScopePill({
  scope,
}: {
  readonly scope: { readonly type: string; readonly [k: string]: unknown };
}): JSX.Element {
  return (
    <span className="rounded border border-border bg-border/20 px-1.5 py-0.5 font-mono text-[11px] text-fg/80">
      {formatScope(scope)}
    </span>
  );
}

/**
 * Surfaces the row's embedding state. Renders nothing for
 * `'present'` (the silent default — the caller's guard skips
 * the component in that case). For `'stale'` the `title`
 * attribute carries the stored model/dim vs configured
 * model/dim so a hover answers "why is this stale" without a
 * click-through.
 */
function EmbeddingPill({
  status,
  stored,
  configured,
}: {
  readonly status: EmbeddingStatus;
  readonly stored: { readonly model: string; readonly dimension: number } | null;
  readonly configured: { readonly model: string; readonly dimension: number } | null;
}): JSX.Element {
  const title =
    status === 'stale'
      ? `Stale: stored ${stored !== null ? `${stored.model}@${stored.dimension}d` : '(no row)'} mismatches configured ${configured !== null ? `${configured.model}@${configured.dimension}d` : '(no embedder wired)'}. Click 'rebuild' below to re-embed.`
      : status === 'pending'
        ? "Pending: vector retrieval is enabled but the embedder hasn't caught up yet (usually milliseconds after a write)."
        : 'Disabled: `retrieval.vector.enabled` is off — only the FTS arm of search is active.';
  const tone = status === 'stale' ? 'border-warn/40 text-warn' : 'border-border text-muted';
  const label = status === 'disabled' ? 'no vec' : status;
  return (
    <span
      className={cn('rounded border bg-border/20 px-1.5 py-0.5 font-mono text-[11px]', tone)}
      title={title}
    >
      ↺ {label}
    </span>
  );
}

function StatusPill({ status }: { readonly status: MemoryRow['status'] }): JSX.Element {
  const tone =
    status === 'active' ? 'text-fg/90' : status === 'forgotten' ? 'text-warn' : 'text-muted';
  return (
    <span
      className={cn(
        'rounded border border-border bg-border/30 px-1.5 py-0.5 font-mono text-[11px]',
        tone,
      )}
    >
      {status}
    </span>
  );
}

function Pill({
  children,
  tone,
}: {
  readonly children: React.ReactNode;
  readonly tone: 'accent' | 'warn';
}): JSX.Element {
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-0.5 font-mono text-[11px]',
        tone === 'accent' ? 'border-accent/40 text-accent' : 'border-warn/40 text-warn',
      )}
    >
      {children}
    </span>
  );
}

function ActionButton({
  onClick,
  pending,
  label,
  title,
  tone,
  disabled,
}: {
  readonly onClick: () => void;
  readonly pending: boolean;
  readonly label: string;
  readonly title: string;
  readonly tone?: 'warn';
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || disabled === true}
      title={title}
      className={cn(
        'rounded border px-2.5 py-1 font-mono text-xs',
        tone === 'warn'
          ? 'border-warn/40 text-warn hover:bg-warn/10'
          : 'border-border text-fg/90 hover:border-fg',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {pending ? '…' : label}
    </button>
  );
}

function SectionLabel({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return <h2 className="font-mono text-[11px] uppercase tracking-widish text-muted">{children}</h2>;
}

function KV({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] uppercase tracking-widish text-muted/80">{label}</span>
      <span className="font-mono text-xs text-fg/90 break-all">{value}</span>
    </div>
  );
}

function ChainRow({
  direction,
  id,
  label,
}: {
  readonly direction: 'up' | 'down';
  readonly id: string;
  readonly label: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span aria-hidden className="text-muted">
        {direction === 'up' ? '↑' : '↓'}
      </span>
      <span className="text-muted">{label}</span>
      <Link to="/memory/$id" params={{ id }} className="text-accent hover:underline break-all">
        {id}
      </Link>
    </div>
  );
}

function EventRow({ event }: { readonly event: MemoryEventRow }): JSX.Element {
  return (
    <li className="flex items-baseline gap-3 border-t border-border px-4 py-2 first:border-t-0 font-mono text-xs">
      <span className="w-20 shrink-0 text-muted">{relativeTime(event.at)}</span>
      <EventTypeBadge type={event.type} />
      <span className="text-muted/80">
        by {event.actor.type}
        {event.actor.id ? `:${event.actor.id}` : ''}
      </span>
      <span className="flex-1 truncate text-fg/80">{summarisePayload(event)}</span>
    </li>
  );
}

function EventTypeBadge({ type }: { readonly type: MemoryEventRow['type'] }): JSX.Element {
  // Lowercase + neutral white. The earlier per-type tone
  // (warn / accent / muted) was too loud for a dense audit
  // timeline; the type label is a readability hint, not a
  // priority cue. Keep all events visually equal.
  return (
    <span
      className={cn(
        'inline-block w-24 shrink-0 rounded border border-border bg-border/30 px-1.5 py-0.5 text-center text-[11px] text-fg',
      )}
    >
      {type}
    </span>
  );
}

function summarisePayload(event: MemoryEventRow): string {
  switch (event.type) {
    case 'updated': {
      const p = event.payload as Record<string, unknown> | undefined;
      if (p === undefined) return '';
      const keys = Object.keys(p);
      return keys.length === 0 ? '' : `patch: ${keys.join(', ')}`;
    }
    case 'superseded': {
      const p = event.payload as { readonly replacementId?: string } | undefined;
      return p?.replacementId ? `replaced by ${p.replacementId}` : '';
    }
    case 'forgotten': {
      const p = event.payload as { readonly reason?: string | null } | undefined;
      return p?.reason !== null && p?.reason !== undefined ? `reason: ${p.reason}` : '';
    }
    case 'reembedded': {
      const p = event.payload as
        | { readonly model?: string; readonly dimension?: number }
        | undefined;
      if (p === undefined) return '';
      return `${p.model ?? '?'} (${p.dimension ?? '?'})`;
    }
    default:
      return '';
  }
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
