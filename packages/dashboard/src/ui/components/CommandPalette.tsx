// Cmd-K command palette.
//
// Accessibility note
// ------------------
//
// This file is exempted from biome's `a11y/useSemanticElements`
// and `a11y/useFocusableInteractive` rules via a file-scoped
// override in `biome.json`. The widget uses ARIA roles on plain
// DOM elements — `role="dialog"` on the modal `<div>`,
// `role="listbox"` on the result container, `role="option"` on
// each row — which is the canonical ARIA pattern for a custom
// command palette. Biome would push us to native `<dialog>`,
// `<select>`, and `<option>`, which are the wrong shape here:
// `<dialog>` would force a different lifecycle (`showModal()` /
// `close()` rather than conditional render) and impose default
// backdrop styling we already control; `<select>`/`<option>`
// are form-input controls with fixed keyboard semantics and no
// rich row content. `tabIndex={-1}` on the listbox keeps it
// programmatically focusable for assistive tech without putting
// it in the tab order — the input drives keyboard nav.
//
// Three input modes triggered by the first character:
//
//   ` `  (default)  — text search via `memory.search`. Live
//                     results render as you type (debounced).
//   `>`             — page navigator. Type a fragment of a route
//                     name and hit Enter to navigate. e.g.
//                     `>conf` matches `~/conflicts` and
//                     `~/config`.
//   `:`             — direct memory open. Paste a ULID, press
//                     Enter, you land on `/memory/<id>`. Useful
//                     when an ID came from a CLI session.
//
// Keyboard nav: ↑/↓ to move the highlight; Enter to commit;
// Esc closes; clicking outside closes. Mouse hover also moves
// the highlight, so the keyboard and pointer flows agree on
// "what would Enter do."
//
// Read-only by design. Destructive actions (forget, archive)
// stay on the memory detail page where the full context — the
// content, the supersession chain, the audit timeline — is
// visible at the moment of the irrevocable choice.

import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type MemoryRow, useMemorySearch } from '../hooks/useMemory.js';
import { cn } from '../lib/cn.js';
import { formatScope, relativeTime } from '../lib/format.js';

/** Routes the palette can navigate to via the `>` prefix. */
const NAV_TARGETS: ReadonlyArray<{ readonly path: string; readonly label: string }> = [
  { path: '/', label: '~/overview' },
  { path: '/memory', label: '~/memory' },
  { path: '/conflicts', label: '~/conflicts' },
  { path: '/audit', label: '~/audit' },
  { path: '/config', label: '~/config' },
  { path: '/system', label: '~/system' },
];

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Mount once at the app root. Owns the open/close state, the
 * global keyboard shortcut, and the modal overlay. The palette
 * itself only renders when open so the cost when unused is the
 * keydown listener.
 */
export function CommandPalette(): JSX.Element {
  const [open, setOpen] = useState(false);

  // Global ⌘K / Ctrl-K toggle. Intercept before the browser's
  // native "address bar" or browser-level Cmd-K shortcut grabs
  // it. This is fine on a same-origin localhost surface.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      if (isCmdK) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return <></>;
  return <PaletteModal onClose={() => setOpen(false)} />;
}

/**
 * The actual modal. Lives in a separate component so its hooks
 * (search, debounce, etc.) only run while the palette is open.
 */
function PaletteModal({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  // Auto-focus on open; without this the user has to click the
  // input first and the keyboard flow falls apart.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const mode = parseMode(query);
  // 250ms is the search-as-you-type sweet spot: short enough that
  // pausing for thought triggers a fetch, long enough that
  // typing letter-by-letter doesn't fan out to 5+ requests for
  // a 5-char query. Combined with `placeholderData: keepPreviousData`
  // on the search hook (results stay visible during refetch),
  // this kills the flash-and-reflow most users perceive as jitter.
  const debounced = useDebounced(mode.kind === 'search' ? mode.text : '', 250);

  // Search mode pulls from `memory.search`; nav and id modes
  // are local computations.
  const search = useMemorySearch(
    mode.kind === 'search' && debounced.length > 0
      ? { text: debounced, includeStatuses: ['active'], limit: 12 }
      : null,
  );

  const items: readonly Item[] = useMemo(() => {
    if (mode.kind === 'nav') {
      const q = mode.text.toLowerCase().trim();
      return NAV_TARGETS.filter((t) =>
        q.length === 0 ? true : t.label.toLowerCase().includes(q) || t.path.includes(q),
      ).map((t) => ({ kind: 'nav' as const, path: t.path, label: t.label }));
    }
    if (mode.kind === 'id') {
      // The `:` prefix carries the candidate id as `mode.text`.
      // We surface it as a single actionable row whether or
      // not it is a syntactically valid ULID — the user gets
      // a clear "open" if it is, and a hint if it isn't.
      return [
        {
          kind: 'id' as const,
          id: mode.text,
          valid: ULID_RE.test(mode.text),
        },
      ];
    }
    if (mode.text.length === 0) {
      return DEFAULT_HINTS;
    }
    const results = search.data?.results ?? [];
    return results.map((r) => ({ kind: 'memory' as const, memory: r.memory }));
  }, [mode, search.data]);

  // Reset highlight when the candidate set shifts. Stops "row 5
  // is highlighted but only 1 row exists" foot-guns.
  useEffect(() => {
    setHighlight(0);
  }, [items]);

  const commit = useCallback(
    (item: Item): void => {
      if (item.kind === 'nav') {
        void navigate({ to: item.path });
        onClose();
        return;
      }
      if (item.kind === 'memory') {
        void navigate({ to: '/memory/$id', params: { id: item.memory.id } });
        onClose();
        return;
      }
      if (item.kind === 'id') {
        if (item.valid) {
          void navigate({ to: '/memory/$id', params: { id: item.id } });
          onClose();
        }
        return;
      }
      // hint rows — no-op on commit
    },
    [navigate, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[highlight];
      if (item !== undefined) commit(item);
    }
  };

  // ARIA roles on plain DOM elements (dialog / listbox / option)
  // are the canonical pattern for custom command palettes —
  // see the file-scoped override in biome.json for the rationale
  // behind disabling `useSemanticElements` here.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/80 px-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        // Click the dimmed backdrop to close. Clicks inside the
        // panel stop propagation via its own handler.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-bg shadow-2xl',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span aria-hidden className="font-mono text-xs text-muted">
            {modeIndicator(mode.kind)}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="search memories  ·  > to navigate  ·  : to open by id"
            className="flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-muted/70"
            aria-label="Command palette input"
          />
          <kbd className="hidden font-mono text-[10px] text-muted/80 sm:inline">esc</kbd>
        </div>

        {/* tabIndex={-1} so the listbox is programmatically
              focusable for AT without sitting in the tab order
              — the input drives keyboard nav (↑/↓/Enter). */}
        <div className="overflow-y-auto" role="listbox" tabIndex={-1}>
          {mode.kind === 'search' &&
          search.isFetching &&
          (search.data?.results ?? []).length === 0 ? (
            <PaletteRowMessage>searching…</PaletteRowMessage>
          ) : items.length === 0 ? (
            <PaletteRowMessage>
              {mode.kind === 'nav' ? 'no matching pages.' : 'no matches.'}
            </PaletteRowMessage>
          ) : (
            items.map((item, idx) => (
              <PaletteRow
                key={rowKey(item, idx)}
                item={item}
                active={idx === highlight}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => commit(item)}
              />
            ))
          )}
        </div>

        <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted/80">
          <span>↑↓ select · enter open · esc close · type</span>
          <span className="mx-1.5 text-muted/60">·</span>
          <span>
            <code className="text-fg/80">{'>'}</code> nav
          </span>
          <span className="mx-1.5 text-muted/60">·</span>
          <span>
            <code className="text-fg/80">:</code> by id
          </span>
        </div>
      </div>
    </div>
  );
}

type Mode =
  | { readonly kind: 'search'; readonly text: string }
  | { readonly kind: 'nav'; readonly text: string }
  | { readonly kind: 'id'; readonly text: string };

function parseMode(query: string): Mode {
  if (query.startsWith('>')) return { kind: 'nav', text: query.slice(1) };
  if (query.startsWith(':')) return { kind: 'id', text: query.slice(1).trim() };
  return { kind: 'search', text: query };
}

function modeIndicator(kind: Mode['kind']): string {
  if (kind === 'nav') return '>';
  if (kind === 'id') return ':';
  return '⌕';
}

type Item =
  | { readonly kind: 'memory'; readonly memory: MemoryRow }
  | { readonly kind: 'nav'; readonly path: string; readonly label: string }
  | { readonly kind: 'id'; readonly id: string; readonly valid: boolean }
  | { readonly kind: 'hint'; readonly label: string };

const DEFAULT_HINTS: readonly Item[] = [
  { kind: 'hint', label: 'type to search memories' },
  { kind: 'hint', label: '> for navigation (e.g. >memory)' },
  { kind: 'hint', label: ': for direct open by ULID' },
];

function rowKey(item: Item, idx: number): string {
  if (item.kind === 'memory') return `m:${item.memory.id}`;
  if (item.kind === 'nav') return `n:${item.path}`;
  if (item.kind === 'id') return `i:${item.id}`;
  return `h:${idx}`;
}

function PaletteRow({
  item,
  active,
  onMouseEnter,
  onClick,
}: {
  readonly item: Item;
  readonly active: boolean;
  readonly onMouseEnter: () => void;
  readonly onClick: () => void;
}): JSX.Element {
  // role="option" inside the parent role="listbox" is the
  // canonical ARIA pattern for a command-palette row — see the
  // file-scoped override in biome.json.
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        'flex w-full items-baseline gap-3 px-3 py-2 text-left',
        active ? 'bg-border/40' : 'hover:bg-border/20',
      )}
    >
      <span
        aria-hidden
        className={cn('font-mono text-[11px]', active ? 'text-accent' : 'text-muted')}
      >
        {item.kind === 'nav' ? '›' : item.kind === 'id' ? ':' : item.kind === 'hint' ? '·' : '⌕'}
      </span>
      <RowBody item={item} />
    </button>
  );
}

function RowBody({ item }: { readonly item: Item }): JSX.Element {
  if (item.kind === 'nav') {
    return (
      <div className="flex flex-col">
        <span className="font-mono text-xs text-fg">{item.label}</span>
        <span className="font-mono text-[10px] text-muted">go to {item.path}</span>
      </div>
    );
  }
  if (item.kind === 'id') {
    return (
      <div className="flex flex-col">
        <span className="font-mono text-xs text-fg break-all">
          {item.id.length === 0 ? 'paste a memory ULID…' : item.id}
        </span>
        <span className="font-mono text-[10px] text-muted">
          {item.id.length === 0 ? '' : item.valid ? 'open detail' : 'not a valid ULID'}
        </span>
      </div>
    );
  }
  if (item.kind === 'hint') {
    return <span className="font-mono text-xs text-muted">{item.label}</span>;
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-2 font-mono text-[11px]">
        <span className="rounded border border-border bg-border/30 px-1 text-fg/80">
          {item.memory.kind.type}
        </span>
        <span className="text-muted">{formatScope(item.memory.scope)}</span>
        {item.memory.pinned ? <span className="text-accent">★</span> : null}
        <span className="text-muted/80">{relativeTime(item.memory.lastConfirmedAt)}</span>
      </div>
      <span className="truncate font-sans text-xs text-fg/90">
        {(item.memory.content ?? '(redacted)').replace(/\s+/g, ' ').trim()}
      </span>
    </div>
  );
}

function PaletteRowMessage({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return <div className="px-3 py-2 font-mono text-xs text-muted">{children}</div>;
}

/**
 * Tiny debounce hook. We don't pull in lodash — `memory.search`
 * is fast on local SQLite, but firing 5 requests for "rest" →
 * "resta" → "restau"… is wasteful and triggers visible flicker
 * in the result list.
 */
function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
