// Single uniform "session expired / no launch token" panel.
//
// The dashboard server gates `/api/*` behind a per-launch token
// stamped into the URL fragment. Two paths land the SPA without
// a usable token:
//
//   1. The user opens the dashboard URL directly (e.g. clicks a
//      bookmarked `http://localhost:4747/memory`) without the
//      `#token=…` fragment a fresh `memento dashboard` invocation
//      mints.
//   2. The server restarted while the tab was open. The token in
//      `sessionStorage` is stale; every API call now returns 401.
//
// Before this component existed each route rendered the raw 401
// message with its own prefix ("failed:", "failed to load
// memory:", "failed to load conflicts:") so the UX read as seven
// different bugs. The fix is a single full-content panel rendered
// from the layout when any query reports `code:
// AUTH_REQUIRED` — see `App.tsx` for the wiring.

import { useQueryClient } from '@tanstack/react-query';

export function TokenMissingPanel(): JSX.Element {
  const qc = useQueryClient();
  return (
    <div className="flex flex-col gap-3">
      <span className="font-mono text-xs text-muted">~/auth</span>
      <h1 className="font-sans text-xl font-semibold tracking-tight">Session expired</h1>
      <p className="font-mono text-sm text-fg/85 leading-relaxed">
        The dashboard's per-launch token is missing or no longer accepted by the server.
      </p>
      <p className="font-mono text-sm text-fg/85 leading-relaxed">
        Open a new dashboard tab from the CLI to mint a fresh token:
      </p>
      <pre className="rounded border border-border bg-bg px-3 py-2 font-mono text-xs text-fg/90">
        memento dashboard
      </pre>
      <p className="font-mono text-[11px] text-muted leading-relaxed">
        Each <code className="text-fg/80">memento dashboard</code> invocation generates a fresh
        token and embeds it in the launch URL's fragment. The fragment never reaches the server, so
        the token can't leak through access logs.
      </p>
      <button
        type="button"
        onClick={() => {
          // Best-effort retry: clear the cache and reload the
          // page in place. If a fresh fragment landed in the URL
          // (some browsers preserve fragments across reload), the
          // SPA will pick it up; otherwise the user sees this
          // panel again.
          qc.clear();
          if (typeof window !== 'undefined') {
            window.location.reload();
          }
        }}
        className="self-start rounded border border-border px-3 py-1.5 font-mono text-xs text-fg/90 hover:border-fg"
      >
        retry
      </button>
    </div>
  );
}
