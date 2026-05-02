// `/config` — config browser + inline editor (D20 + D22).
//
// `config.list` returns every key with its resolved value and
// provenance. We group by dotted prefix (`retrieval.*`,
// `decay.*`, …) so the user can scan a related cluster at once.
// Each row is collapsed by default; expanding reveals:
//
//   1. A typed editor (boolean / number / string / JSON) when
//      the key is mutable. The editor type is inferred from the
//      current value's runtime type — `typeof boolean` →
//      checkbox, `typeof number` → number input, `typeof string`
//      → text input, otherwise → JSON textarea.
//   2. A "save" / "reset to default" pair (Reset only when the
//      effective source is `runtime`).
//   3. The key's history (`config.history`).
//
// Mutability gating
// -----------------
//
// `config.list` does not carry the `mutable` flag on the wire
// (the schema does not expose it; ADR-0018 forbids new fields
// without a separate ADR). We rely on a client-side allow-list
// of known immutable keys plus the server's `IMMUTABLE` error
// code as the canonical fallback. If a future migration adds an
// immutable key the dashboard does not yet know about, the
// editor renders, the user attempts a write, and the engine's
// `IMMUTABLE` response surfaces inline as a friendly read-only
// lock.
//
// Validation surfaces engine-side. Per-key Zod schemas live in
// `@psraghuveer/memento-schema/config-keys.ts`; `config.set`
// runs them and returns `INVALID_INPUT` with the parse error
// message on failure. The editor renders that message inline
// without re-implementing the schema in the browser.

import { useMemo, useState } from 'react';

import {
  type ConfigEntry,
  useConfigHistory,
  useConfigList,
  useSetConfig,
  useUnsetConfig,
} from '../hooks/useConfig.js';
import { cn } from '../lib/cn.js';
import { relativeTime } from '../lib/format.js';

/**
 * Keys flagged `mutable: false` in
 * `@psraghuveer/memento-schema/config-keys.ts`. Kept in sync
 * by hand; CI-side could pin via a snapshot test if drift
 * becomes a real risk. Today the list is short and stable.
 */
const IMMUTABLE_KEYS: ReadonlySet<string> = new Set([
  'storage.busyTimeoutMs',
  'retrieval.fts.tokenizer',
  'retrieval.vector.backend',
  'embedder.local.model',
  'embedder.local.dimension',
]);

export function ConfigPage(): JSX.Element {
  const [filter, setFilter] = useState('');
  const config = useConfigList();
  const rows = config.data ?? [];

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q));
  }, [rows, filter]);

  const groups = useMemo(() => groupByPrefix(filtered), [filtered]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">~/config</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">Config keys</h1>
        <p className="font-mono text-xs text-muted">
          mutable keys edit inline; immutable keys are read-only. Per-key validation runs
          engine-side via <code className="text-fg/80">config.set</code>.
        </p>
      </header>

      <label className="flex items-center gap-2 rounded border border-border bg-bg px-3 py-2 focus-within:border-fg">
        <span aria-hidden className="font-mono text-xs text-muted">
          ⌕
        </span>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by key prefix… (e.g. retrieval, decay, scrubber)"
          className="flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-muted/70"
          aria-label="Filter config keys"
        />
        {filter.length > 0 ? (
          <button
            type="button"
            onClick={() => setFilter('')}
            className="font-mono text-xs text-muted hover:text-fg"
            aria-label="Clear filter"
          >
            ✕
          </button>
        ) : null}
      </label>

      {config.isLoading ? (
        <p className="font-mono text-xs text-muted">loading config.list…</p>
      ) : config.error !== null && config.error !== undefined ? (
        <p className="font-mono text-xs text-warn">
          failed: {(config.error as { message?: string })?.message ?? String(config.error)}
        </p>
      ) : groups.length === 0 ? (
        <p className="rounded border border-border px-4 py-3 font-mono text-xs text-muted">
          no keys match.
        </p>
      ) : (
        groups.map((group) => <ConfigGroup key={group.prefix} group={group} />)
      )}
    </div>
  );
}

interface Group {
  readonly prefix: string;
  readonly entries: readonly ConfigEntry[];
}

function ConfigGroup({ group }: { readonly group: Group }): JSX.Element {
  return (
    <section aria-label={group.prefix} className="flex flex-col gap-2">
      <h2 className="font-mono text-[11px] uppercase tracking-widish text-muted">{group.prefix}</h2>
      <div className="overflow-hidden rounded border border-border">
        <ul>
          {group.entries.map((entry) => (
            <ConfigRow key={entry.key} entry={entry} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function ConfigRow({ entry }: { readonly entry: ConfigEntry }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const mutable = !IMMUTABLE_KEYS.has(entry.key);

  return (
    <li className="border-t border-border first:border-t-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex w-full flex-col gap-1.5 px-4 py-3 text-left',
          'hover:bg-border/30',
          'sm:flex-row sm:items-baseline sm:gap-3',
        )}
        aria-expanded={expanded}
      >
        <span className="flex-1 font-mono text-xs text-fg">{entry.key}</span>
        <span className="font-mono text-[11px] text-fg/80 break-all">
          {formatValue(entry.value)}
        </span>
        <SourcePill source={entry.source} mutable={mutable} />
        <span aria-hidden className="font-mono text-[11px] text-muted">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded ? <ConfigDetail entry={entry} mutable={mutable} /> : null}
    </li>
  );
}

function ConfigDetail({
  entry,
  mutable,
}: {
  readonly entry: ConfigEntry;
  readonly mutable: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 border-t border-border bg-border/10 px-4 py-3 font-mono text-[11px]">
      {mutable ? (
        <ConfigEditor entry={entry} />
      ) : (
        <p className="text-muted">
          immutable — set via startup config; cannot be changed at runtime.
        </p>
      )}
      <ConfigHistory keyName={entry.key} />
      <CopyCommand entry={entry} />
    </div>
  );
}

/**
 * Inline editor for a mutable config key. The editor type is
 * inferred from the current value's runtime type. Save calls
 * `config.set`; on `IMMUTABLE` (a server-side correction to the
 * client-side allow-list) the editor locks down with the
 * server's message; on `INVALID_INPUT` the parse error is shown
 * inline.
 */
function ConfigEditor({ entry }: { readonly entry: ConfigEntry }): JSX.Element {
  const inferred = inferEditorType(entry.value);
  const [draft, setDraft] = useState<string>(initialDraft(entry.value, inferred));
  const [draftBool, setDraftBool] = useState<boolean>(
    typeof entry.value === 'boolean' ? entry.value : false,
  );
  const set = useSetConfig();
  const unset = useUnsetConfig();

  const save = (): void => {
    const parsed = parseDraft(inferred, draft, draftBool);
    if (!parsed.ok) {
      // Local syntactic failure (e.g. malformed JSON). The
      // engine-side per-key Zod validator runs after this.
      set.reset();
      // We surface local errors via the same `set.error` pipe
      // by manufacturing one through a no-op set-then-reset
      // pattern — simplest is just to track a local error.
      setLocalError(parsed.message);
      return;
    }
    setLocalError(null);
    set.mutate({ key: entry.key, value: parsed.value });
  };

  const reset = (): void => {
    if (
      !window.confirm(
        `Reset ${entry.key} to its default? This calls config.unset and removes the runtime override.`,
      )
    ) {
      return;
    }
    unset.mutate({ key: entry.key });
  };

  const [localError, setLocalError] = useState<string | null>(null);
  const remoteError = (set.error ?? unset.error) as { code?: string; message?: string } | null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] uppercase tracking-widish text-muted/80">edit</span>
      <div className="flex flex-wrap items-center gap-2">
        {inferred === 'boolean' ? (
          <label className="flex items-center gap-1.5 text-fg/90">
            <input
              type="checkbox"
              checked={draftBool}
              onChange={(e) => setDraftBool(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            {draftBool ? 'true' : 'false'}
          </label>
        ) : inferred === 'number' ? (
          <input
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-fg"
            step="any"
          />
        ) : inferred === 'string' ? (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-[12rem] flex-1 rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-fg"
          />
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="w-full rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-fg"
            spellCheck={false}
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={set.isPending}
          className="rounded border border-border px-2 py-0.5 text-fg/90 hover:border-fg disabled:opacity-50"
        >
          {set.isPending ? 'saving…' : 'save'}
        </button>
        {entry.source === 'runtime' ? (
          <button
            type="button"
            onClick={reset}
            disabled={unset.isPending}
            className="rounded border border-border px-2 py-0.5 text-muted hover:border-fg hover:text-fg disabled:opacity-50"
            title="config.unset removes the runtime override and falls back to the next layer"
          >
            {unset.isPending ? 'resetting…' : 'reset'}
          </button>
        ) : null}
      </div>
      {set.isSuccess ? <p className="text-accent">saved.</p> : null}
      {unset.isSuccess ? <p className="text-accent">reset to default.</p> : null}
      {localError !== null ? <p className="text-warn">{localError}</p> : null}
      {remoteError !== null && remoteError !== undefined ? (
        <p className="text-warn">
          {remoteError.code === 'IMMUTABLE'
            ? 'this key is immutable — cannot be changed at runtime.'
            : remoteError.code === 'INVALID_INPUT'
              ? `validation failed: ${remoteError.message ?? 'invalid value'}`
              : `failed: ${remoteError.message ?? 'unknown error'}`}
        </p>
      ) : null}
    </div>
  );
}

type EditorType = 'boolean' | 'number' | 'string' | 'json';

function inferEditorType(value: unknown): EditorType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'json';
}

function initialDraft(value: unknown, type: EditorType): string {
  if (type === 'boolean') return '';
  if (type === 'number' || type === 'string') return value === null ? '' : String(value);
  // JSON mode — pretty-printed for readability.
  try {
    return value === undefined ? 'null' : JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

function parseDraft(type: EditorType, draft: string, draftBool: boolean): ParseResult {
  if (type === 'boolean') return { ok: true, value: draftBool };
  if (type === 'number') {
    const n = Number(draft);
    if (!Number.isFinite(n)) return { ok: false, message: 'not a finite number' };
    return { ok: true, value: n };
  }
  if (type === 'string') return { ok: true, value: draft };
  try {
    return { ok: true, value: JSON.parse(draft) as unknown };
  } catch (cause) {
    return {
      ok: false,
      message: `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

function ConfigHistory({ keyName }: { readonly keyName: string }): JSX.Element {
  const history = useConfigHistory(keyName);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widish text-muted/80">history</span>
      {history.isLoading ? (
        <span className="text-muted">loading…</span>
      ) : history.error !== null && history.error !== undefined ? (
        <span className="text-warn">
          failed: {(history.error as { message?: string })?.message ?? String(history.error)}
        </span>
      ) : (history.data ?? []).length === 0 ? (
        <span className="text-muted">no history — value is at default.</span>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {(history.data ?? []).map((event) => (
            <li key={event.id} className="text-fg/80">
              {relativeTime(event.at)} ·{' '}
              <span className="text-muted/80">
                {formatValue(event.oldValue)} → {formatValue(event.newValue)}
              </span>{' '}
              by {event.actor.type}
              {event.actor.id ? `:${event.actor.id}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CopyCommand({ entry }: { readonly entry: ConfigEntry }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widish text-muted/80">cli equivalent</span>
      <code className="select-all break-all text-fg">
        memento config set {entry.key} '{formatValue(entry.value)}'
      </code>
    </div>
  );
}

function SourcePill({
  source,
  mutable,
}: {
  readonly source: ConfigEntry['source'];
  readonly mutable: boolean;
}): JSX.Element {
  const tone = source === 'runtime' ? 'border-accent/40 text-accent' : 'border-border text-muted';
  const label = mutable ? source : `${source} · immutable`;
  return (
    <span
      className={cn(
        'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widish',
        tone,
      )}
    >
      {label}
    </span>
  );
}

function formatValue(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return 'undefined';
    if (s.length <= 80) return s;
    return `${s.slice(0, 79)}…`;
  } catch {
    return String(value);
  }
}

function groupByPrefix(entries: readonly ConfigEntry[]): readonly Group[] {
  const map = new Map<string, ConfigEntry[]>();
  for (const e of entries) {
    const dot = e.key.indexOf('.');
    const prefix = dot === -1 ? e.key : e.key.slice(0, dot);
    const arr = map.get(prefix) ?? [];
    arr.push(e);
    map.set(prefix, arr);
  }
  return Array.from(map.entries())
    .map(([prefix, list]) => ({
      prefix,
      entries: [...list].sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}
