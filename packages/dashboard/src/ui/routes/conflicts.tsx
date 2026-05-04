// `/conflicts` — open conflict triage.
//
// Layout
// ------
//
// A list of pending conflicts, each rendered as a card showing
// both memories side-by-side and the four resolution buttons
// (`accept-new`, `accept-existing`, `supersede`, `ignore`).
//
// Each row is two `useMemoryRead` calls (one per memory id) so
// the user sees the actual content rather than just IDs. The
// reads are cached at the React-Query level so jumping between
// pages does not re-fetch.
//
// `accept-new` and `accept-existing` resolve the conflict
// without changing memory status — the policy decision is
// recorded in the conflict event log; the user's deeper
// follow-up (forget the loser, supersede with a merged version)
// is left to the memory detail page. A future "supersede +
// resolve" combo step is feasible but out of scope here per
// ADR-0018's "no auto-resolution" stance.

import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import {
  type ConflictResolution,
  type ConflictRow,
  useConflictList,
  useResolveConflict,
  useScanConflicts,
} from '../hooks/useConflict.js';
import { useMemoryRead } from '../hooks/useMemory.js';
import { cn } from '../lib/cn.js';
import { formatScope, relativeTime } from '../lib/format.js';

// Conflict-list pagination: bumps the engine `limit` per click,
// capped at the engine's `conflict.list.maxLimit` default. Same
// idiom as the memory + audit pages.
const LOAD_MORE_PAGE = 100;
const LOAD_MORE_MAX = 1_000;

export function ConflictsPage(): JSX.Element {
  const [displayLimit, setDisplayLimit] = useState(LOAD_MORE_PAGE);
  const conflicts = useConflictList({ open: true, limit: displayLimit });
  const scan = useScanConflicts();

  const handleScan = (): void => {
    // `since` mode replays detection over the last 24 hours.
    // The repository clamps the window; this is a sensible
    // "I think I missed something" recovery for a lay user.
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    scan.mutate({ mode: 'since', since });
  };

  const list = conflicts.data ?? [];
  const isLoading = conflicts.isLoading;
  const error = conflicts.error;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">~/conflicts</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">Triage conflicts</h1>
      </header>

      {/* Action row — same reasoning as the memory list: the
          fetched-page count was misleading because it caps at
          conflict.list.maxLimit. The overview tile owns the
          accurate count (rendered as `1,000+` when capped); this
          page just shows the actions. */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleScan}
          disabled={scan.isPending}
          className={cn(
            'rounded border border-border px-2 py-0.5 font-mono text-xs',
            'hover:border-fg hover:text-fg disabled:opacity-50',
          )}
          title="Re-run conflict detection on memories created in the last 24h (conflict.scan)"
        >
          {scan.isPending ? 'scanning…' : 're-scan (24h)'}
        </button>
      </div>

      {scan.error !== null && scan.error !== undefined ? (
        <p className="font-mono text-xs text-warn">
          scan failed: {(scan.error as { message?: string })?.message ?? String(scan.error)}
        </p>
      ) : null}
      {scan.data !== undefined ? (
        <p className="font-mono text-xs text-muted">
          scanned {scan.data.scanned} memories; {scan.data.opened.length} new conflict
          {scan.data.opened.length === 1 ? '' : 's'} opened.
        </p>
      ) : null}

      <section aria-label="Open conflicts" className="flex flex-col gap-3">
        {isLoading ? (
          <p className="rounded border border-border px-4 py-3 font-mono text-xs text-muted">
            loading…
          </p>
        ) : error !== null && error !== undefined ? (
          <p className="rounded border border-border px-4 py-3 font-mono text-xs text-warn">
            failed to load conflicts: {(error as { message?: string })?.message ?? String(error)}
          </p>
        ) : list.length === 0 ? (
          <EmptyState />
        ) : (
          list.map((conflict) => <ConflictCard key={conflict.id} conflict={conflict} />)
        )}
      </section>

      {list.length === displayLimit && displayLimit < LOAD_MORE_MAX ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setDisplayLimit((d) => Math.min(d + LOAD_MORE_PAGE, LOAD_MORE_MAX))}
            disabled={conflicts.isFetching}
            className="rounded border border-border px-3 py-1.5 font-mono text-xs text-fg/90 hover:border-fg disabled:opacity-50"
          >
            {conflicts.isFetching
              ? 'loading…'
              : `load next ${Math.min(LOAD_MORE_PAGE, LOAD_MORE_MAX - displayLimit)}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ConflictCard({ conflict }: { readonly conflict: ConflictRow }): JSX.Element {
  const newer = useMemoryRead(conflict.newMemoryId);
  const existing = useMemoryRead(conflict.conflictingMemoryId);
  const resolve = useResolveConflict();

  const handleResolve = (resolution: ConflictResolution): void => {
    resolve.mutate({ id: conflict.id, resolution });
  };

  return (
    <article className="flex flex-col gap-3 rounded border border-border p-4">
      <header className="flex flex-wrap items-baseline gap-2 font-mono text-[11px]">
        <span className="rounded border border-border bg-border/30 px-1.5 py-0.5 text-fg/80">
          {conflict.kind}
        </span>
        <span className="text-muted">opened {relativeTime(conflict.openedAt)}</span>
        <span className="text-muted/70">·</span>
        <span className="text-muted/80 select-all">{conflict.id}</span>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <MemoryPanel
          title="newer"
          memory={newer.data}
          loading={newer.isLoading}
          error={newer.error}
          memoryId={conflict.newMemoryId}
        />
        <MemoryPanel
          title="existing"
          memory={existing.data}
          loading={existing.isLoading}
          error={existing.error}
          memoryId={conflict.conflictingMemoryId}
        />
      </div>

      {/* Evidence — kind-policy specific shape. We render JSON
          so the user can see whatever the post-write hook
          captured; UI improvements live in a follow-up. */}
      {conflict.evidence !== null && conflict.evidence !== undefined ? (
        <details className="font-mono text-[11px] text-muted">
          <summary className="cursor-pointer hover:text-fg">evidence</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded border border-border bg-bg p-2 text-fg/80">
            {JSON.stringify(conflict.evidence, null, 2)}
          </pre>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <ResolveButton
          label="accept new"
          onClick={() => handleResolve('accept-new')}
          pending={resolve.isPending}
          title="Record acceptance of the newer memory; both rows remain. (conflict.resolve resolution=accept-new)"
        />
        <ResolveButton
          label="keep existing"
          onClick={() => handleResolve('accept-existing')}
          pending={resolve.isPending}
          title="Record acceptance of the existing memory; both rows remain. (conflict.resolve resolution=accept-existing)"
        />
        <ResolveButton
          label="supersede"
          onClick={() => handleResolve('supersede')}
          pending={resolve.isPending}
          title="Note that one supersedes the other; follow up with memory.supersede on the detail page if needed."
        />
        <ResolveButton
          label="ignore"
          onClick={() => handleResolve('ignore')}
          pending={resolve.isPending}
          title="Mark resolved without action — the conflict is no longer flagged."
        />
        {resolve.error !== null && resolve.error !== undefined ? (
          <span className="font-mono text-xs text-warn">
            failed: {(resolve.error as { message?: string })?.message ?? String(resolve.error)}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function MemoryPanel({
  title,
  memory,
  loading,
  error,
  memoryId,
}: {
  readonly title: string;
  readonly memory: Parameters<typeof useMemoryRead>[0] extends infer _
    ? ReturnType<typeof useMemoryRead>['data']
    : never;
  readonly loading: boolean;
  readonly error: unknown;
  readonly memoryId: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded border border-border bg-border/10 p-3">
      <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-widish text-muted">
        <span>{title}</span>
        <Link
          to="/memory/$id"
          params={{ id: memoryId }}
          className="normal-case tracking-normal text-muted hover:text-fg"
        >
          open →
        </Link>
      </div>
      {loading ? (
        <p className="font-mono text-xs text-muted">loading…</p>
      ) : error !== null && error !== undefined ? (
        <p className="font-mono text-xs text-warn">
          failed: {(error as { message?: string })?.message ?? String(error)}
        </p>
      ) : memory === undefined ? (
        <p className="font-mono text-xs text-muted">not found.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
            <span className="rounded border border-border bg-border/30 px-1 text-fg/80">
              {memory.kind.type}
            </span>
            <span className="text-muted/80">{formatScope(memory.scope)}</span>
            {memory.pinned ? <span className="text-accent">★</span> : null}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs text-fg">
            {memory.content === null ? '(redacted)' : memory.content}
          </pre>
          {memory.tags.length > 0 ? (
            <p className="font-mono text-[11px] text-muted/80">tags: [{memory.tags.join(',')}]</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function ResolveButton({
  label,
  onClick,
  pending,
  title,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly pending: boolean;
  readonly title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={title}
      className={cn(
        'rounded border border-border px-2.5 py-1 font-mono text-xs',
        'text-fg/90 hover:border-fg hover:bg-border/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {label}
    </button>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded border border-border px-4 py-6 font-mono text-xs text-muted">
      <p className="text-fg/90">no open conflicts. all clear.</p>
      <p className="text-muted/80">
        conflicts surface from the post-write hook ({' '}
        <code className="text-fg/80">conflict.timeoutMs = 2000</code>) and are visible here as soon
        as they open.
      </p>
    </div>
  );
}
