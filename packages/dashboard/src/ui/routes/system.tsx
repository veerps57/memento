// `/system` — system & health (D19 + D24).
//
// Single-call view (`system.info`) with derived "doctor-style"
// probes:
//
//   - DB path present + readable (server tells us the path; if
//     the call returned at all the file was openable).
//   - Vector retrieval: enabled? embedder configured? model name
//     and dimension if so.
//   - Schema version is the latest the bundle knows about.
//   - Active / archived / forgotten / superseded counts.
//
// Each probe renders ok / warn / off. The page is intentionally
// dense and read-only; mutations live on the relevant pages
// (config, embedding rebuild — both reachable from here as
// follow-ups).

import { useScopeList, useSystemInfo } from '../hooks/useSystemInfo.js';
import { cn } from '../lib/cn.js';
import { compactNumber, relativeTime } from '../lib/format.js';

export function SystemPage(): JSX.Element {
  const info = useSystemInfo();
  const scopes = useScopeList();

  const data = info.data;
  const lastWriteAt = computeLastWriteAt(scopes.data?.scopes ?? []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">~/system</span>
        <h1 className="font-sans text-xl font-semibold tracking-tight">System & health</h1>
      </header>

      {info.isLoading ? (
        <p className="font-mono text-xs text-muted">loading system.info…</p>
      ) : info.error !== null && info.error !== undefined ? (
        <p className="font-mono text-xs text-warn">
          failed: {(info.error as { message?: string })?.message ?? String(info.error)}
        </p>
      ) : data === undefined ? (
        <p className="font-mono text-xs text-muted">no data.</p>
      ) : (
        <>
          {/* Probe row */}
          <section
            aria-label="Health probes"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            <Probe
              label="database"
              status={data.dbPath !== null ? 'ok' : 'warn'}
              value={data.dbPath ?? '(in-memory)'}
              note="opened on first registry call"
            />
            <Probe
              label="vector retrieval"
              status={data.vectorEnabled ? 'ok' : 'off'}
              value={data.vectorEnabled ? 'on' : 'off'}
              note={
                data.vectorEnabled
                  ? `${data.embedder.model} · ${data.embedder.dimension}d`
                  : 'fts only — set retrieval.vector.enabled=true to enable'
              }
            />
            <Probe
              label="embedder"
              status={data.embedder.configured ? 'ok' : data.vectorEnabled ? 'warn' : 'off'}
              value={data.embedder.configured ? 'configured' : 'not configured'}
              note={
                data.embedder.configured
                  ? `${data.embedder.model} · ${data.embedder.dimension}d`
                  : data.vectorEnabled
                    ? 'vector enabled but embedder is missing — re-install or run memento embedding rebuild'
                    : '—'
              }
            />
            <Probe
              label="schema version"
              status="ok"
              value={`v${data.schemaVersion}`}
              note="latest migration applied"
            />
            <Probe
              label="last write"
              status={lastWriteAt === null ? 'off' : 'ok'}
              value={lastWriteAt === null ? '—' : relativeTime(lastWriteAt)}
              note={lastWriteAt === null ? 'no writes yet' : 'across all scopes'}
            />
            <Probe
              label="version"
              status="ok"
              value={`memento ${data.version}`}
              note="dashboard runs in-process with the engine"
            />
          </section>

          {/* Counts */}
          <section aria-label="Status counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CountTile label="active" value={data.counts.active} tone="accent" />
            <CountTile label="archived" value={data.counts.archived} />
            <CountTile label="forgotten" value={data.counts.forgotten} tone="muted" />
            <CountTile label="superseded" value={data.counts.superseded} tone="muted" />
          </section>
        </>
      )}
    </div>
  );
}

type ProbeStatus = 'ok' | 'warn' | 'off';

function Probe({
  label,
  status,
  value,
  note,
}: {
  readonly label: string;
  readonly status: ProbeStatus;
  readonly value: string;
  readonly note: string;
}): JSX.Element {
  const indicator = status === 'ok' ? '●' : status === 'warn' ? '▲' : '○';
  const tone = status === 'ok' ? 'text-accent' : status === 'warn' ? 'text-warn' : 'text-muted/70';
  return (
    <div className="flex flex-col gap-1.5 rounded border border-border p-3">
      <div className="flex items-baseline gap-2">
        <span className={cn('font-mono text-xs', tone)} aria-hidden>
          {indicator}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widish text-muted">{label}</span>
      </div>
      <span className="break-all font-mono text-sm text-fg">{value}</span>
      <span className="font-mono text-[11px] text-muted/80">{note}</span>
    </div>
  );
}

function CountTile({
  label,
  value,
  tone = 'fg',
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'accent' | 'fg' | 'muted';
}): JSX.Element {
  const valueClass =
    tone === 'accent' ? 'text-accent' : tone === 'muted' ? 'text-muted' : 'text-fg';
  return (
    <div className="flex flex-col gap-1 rounded border border-border p-3">
      <span className="font-mono text-[10px] uppercase tracking-widish text-muted">{label}</span>
      <span className={cn('font-mono text-2xl tabular-nums', valueClass)}>
        {compactNumber(value)}
      </span>
      <span className="font-mono text-[11px] text-muted/80">{value.toLocaleString()} total</span>
    </div>
  );
}

function computeLastWriteAt(
  scopes: ReadonlyArray<{ readonly lastWriteAt: string | null }>,
): string | null {
  let max: string | null = null;
  for (const s of scopes) {
    if (s.lastWriteAt !== null && (max === null || s.lastWriteAt > max)) {
      max = s.lastWriteAt;
    }
  }
  return max;
}
