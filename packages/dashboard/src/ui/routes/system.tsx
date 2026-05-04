// `/system` — system & health.
//
// Doctor-style probes ordered along the dependency chain that
// makes the engine work in the first place:
//
//   1. Node     — the runtime that runs everything.
//   2. Database — the SQLite file behind the engine.
//   3. Native binding — the better-sqlite3 .node addon.
//   4. Vector retrieval — search capability config (with the
//      embedder model + dimension as the note line, since those
//      only matter when vector retrieval is on).
//   5. Scrubber — the write-path redaction master switch; the
//      load-bearing defence against accidentally-persisted
//      secrets.
//   6. Version — the memento package version, last so the page
//      ends on identity rather than a probe.
//
// The standalone embedder probe used to live here too but was
// redundant: the model + dimension already showed up under
// `vector retrieval`, and the only extra signal it added (warn
// if vector is on but embedder missing) is rolled into the
// `vector retrieval` probe's `warn` state directly.
//
// `schema version` and `last write` previously lived here too;
// schema version is invariant for any version of the bundle and
// adds noise, and last-write is content-state (rendered on the
// overview tile). Both moved off this page in favour of focus.
//
// The per-status memory counts that used to live here have moved
// to the overview page (`~/`). Repeating them on a "system" page
// gave them undue prominence — counts are a content stat, not a
// system-health signal — and the overview's `BY STATUS` row is
// the one canonical place to read them.
//
// Each probe renders ok / warn / off. The page is intentionally
// dense and read-only; mutations live on the relevant pages
// (config, embedding rebuild — both reachable from here as
// follow-ups).

import { useSystemInfo } from '../hooks/useSystemInfo.js';
import { cn } from '../lib/cn.js';

export function SystemPage(): JSX.Element {
  const info = useSystemInfo();

  const data = info.data;

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
          {/* Probe row — order is the dependency chain
              (runtime → storage → search → identity). */}
          <section
            aria-label="Health probes"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {/* Process-level probes lifted from the doctor
                checks. The very fact that `system.info` returned
                means better-sqlite3 loaded successfully — the
                native-binding probe is "ok" by definition; if
                the binding had failed the engine couldn't have
                served this response. The Node version + modules
                ABI line is the same readout `memento doctor`
                prints, so a user hitting an ABI mismatch on the
                CLI can confirm it from the dashboard too. */}
            <Probe
              label="node"
              status="ok"
              value={`v${data.runtime.node}`}
              note={`modules abi ${data.runtime.modulesAbi}`}
            />
            <Probe
              label="database"
              status={data.dbPath !== null ? 'ok' : 'warn'}
              value={data.dbPath ?? '(in-memory)'}
              note="opened on first registry call"
            />
            <Probe
              label="native binding"
              status={data.runtime.nativeBinding === 'ok' ? 'ok' : 'warn'}
              value={data.runtime.nativeBinding === 'ok' ? 'loaded' : 'unhealthy'}
              note="better-sqlite3 — re-run `memento doctor` for full probe output"
            />
            {/* Vector-retrieval probe absorbs the embedder
                signal: the model + dimension are useful only
                when vector retrieval is on, and the only failure
                mode the standalone embedder probe used to flag
                ("vector enabled but embedder missing") fits
                naturally as a `warn` here. */}
            <Probe
              label="vector retrieval"
              status={!data.vectorEnabled ? 'off' : data.embedder.configured ? 'ok' : 'warn'}
              value={data.vectorEnabled ? 'on' : 'off'}
              note={
                !data.vectorEnabled
                  ? 'fts only — set retrieval.vector.enabled=true to enable'
                  : data.embedder.configured
                    ? `${data.embedder.model} · ${data.embedder.dimension}d`
                    : 'enabled but embedder missing — run memento embedding rebuild'
              }
            />
            {/* Scrubber state — the redaction safety net is
                pinned at server start (`scrubber.enabled` is
                `mutable: false`). Surfacing it here lets the
                user confirm at a glance that writes are being
                scrubbed before persistence. */}
            <Probe
              label="scrubber"
              status={data.scrubber.enabled ? 'ok' : 'warn'}
              value={data.scrubber.enabled ? 'on' : 'off'}
              note={
                data.scrubber.enabled
                  ? 'write-path redaction active — pinned at server start'
                  : 'disabled — writes pass through unredacted (set scrubber.enabled=true at startup)'
              }
            />
            <Probe
              label="version"
              status="ok"
              value={`memento ${data.version}`}
              note="dashboard runs in-process with the engine"
            />
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
  // Traffic-light mapping using the theme's existing tokens —
  // `synapse` (cyan-teal, the "confirm / durable" color also
  // used by the headline vector-on tile) reads as the green
  // closest to a "good state" indicator without introducing a
  // new palette entry; `warn` keeps the amber middle state;
  // `destructive` (muted red) takes over the previously-grey
  // "off" slot so the user can scan the column at a glance.
  // The previous mapping had `ok` and `warn` both rendering in
  // the amber family, which made the dot ambiguous at the small
  // sizes used here.
  const tone =
    status === 'ok' ? 'text-synapse' : status === 'warn' ? 'text-warn' : 'text-destructive';
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
