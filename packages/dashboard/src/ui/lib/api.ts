// API client for the dashboard's `/api/commands/:name` surface.
//
// The dashboard server exposes a generic registry-over-HTTP
// endpoint (see `src/server/commands.ts`); this client wraps it.
//
// Two important contracts the client honours:
//
//   1. The HTTP body is the command's `Result<T>` envelope
//      verbatim. Success → `{ ok: true, value: T }`; failure →
//      `{ ok: false, error: { code, message, details? } }`. The
//      client returns the typed `Result` to its caller.
//
//   2. HTTP status codes are advisory; the canonical signal is
//      the envelope's `ok` field. We treat any 2xx as "the
//      server processed the request" — even a 4xx with a valid
//      Result envelope just means "the command failed" and is
//      returned as-is.
//
// The API base path is relative; in dev, Vite proxies `/api/*`
// to the dashboard server; in production, the server itself
// serves both static UI and the API on the same origin.
//
// Authentication. The launcher mints a per-launch random token
// and embeds it in the URL fragment (`#token=…`). On first load
// the SPA reads the fragment, copies the token into
// `sessionStorage`, then strips it from the URL so it does not
// linger in the address bar. Every API call sends
// `Authorization: Bearer <token>`. A page reload that loses
// `sessionStorage` (e.g. a hard refresh in a different tab)
// will need the launcher's URL again — this is intentional:
// the alternative (persist in `localStorage`) would let any
// future page on `localhost:<port>` learn the token.

export interface ApiOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ApiErr {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly hint?: string;
  };
}

export type ApiResult<T> = ApiOk<T> | ApiErr;

const TOKEN_STORAGE_KEY = 'memento.dashboard.token';

/**
 * Synthetic error code surfaced when the SPA was loaded without
 * the launch token — either because the user opened the URL
 * without the `#token=…` fragment, or because the server
 * restarted and minted a fresh token while the tab was open.
 *
 * Pages render a single uniform "session expired" panel for this
 * code instead of every route showing the raw 401 message with a
 * different prefix. The dashboard server ALSO returns this code
 * verbatim on a 401 so a single client-side check covers both
 * "no token at all" and "token rejected by server". Keep this
 * literal in sync with the matching constant in
 * `dashboard/src/ui/components/TokenMissingPanel.tsx`.
 */
export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';

/**
 * Read the launch token from `window.location.hash`, persist it
 * to `sessionStorage`, and clear the fragment so it does not
 * sit in the address bar. Idempotent: subsequent calls just
 * return the stored value.
 *
 * Returns `null` only if the page was loaded without a `#token=`
 * fragment AND `sessionStorage` does not already hold one — that
 * means the user opened the dashboard URL without the token.
 * Every API call rejects in that case.
 */
function readToken(): string | null {
  if (typeof window === 'undefined') return null;
  const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  if (stored !== null) return stored;
  const hash = window.location.hash;
  // Hash forms: `#token=…` or `#…&token=…`. Both ride on a URL
  // fragment, which is never sent to the server, so the launcher's
  // access log can never observe the token.
  const match = /(?:^#|&)token=([^&]+)/u.exec(hash);
  if (match === null) return null;
  const fresh = decodeURIComponent(match[1] ?? '');
  if (fresh === '') return null;
  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fresh);
  // Strip the fragment from the address bar so it does not get
  // copy-pasted by accident. `replaceState` keeps the navigation
  // history clean.
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  return fresh;
}

function authHeaders(): HeadersInit {
  const token = readToken();
  if (token === null) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Call a registered Memento command by name.
 *
 * @example
 * const r = await callCommand<SystemInfo>('system.info');
 * if (r.ok) console.log(r.value.counts);
 */
export async function callCommand<T = unknown>(
  name: string,
  input: unknown = {},
): Promise<ApiResult<T>> {
  // Pre-flight: if the launch token is unrecoverable (no fragment
  // and nothing in sessionStorage), short-circuit to a uniform
  // AUTH_REQUIRED error instead of issuing a 401-bound request
  // whose error envelope leaks server-side wording into every
  // page's "failed: …" line.
  if (readToken() === null) {
    return {
      ok: false,
      error: {
        code: AUTH_REQUIRED_CODE,
        message: 'Dashboard launch token is missing.',
        hint: 'Re-open the dashboard via `memento dashboard` to get a fresh launch URL.',
      },
    };
  }
  const response = await fetch(`/api/commands/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  // A 401 from the server means the token in sessionStorage is
  // stale (server restarted while the tab was open). Forget the
  // dead token so a subsequent reload-with-fragment can plant a
  // fresh one without our cache shadowing it, and synthesise the
  // AUTH_REQUIRED code regardless of the server's specific error
  // wording — every route renders the same panel.
  if (response.status === 401) {
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
    return {
      ok: false,
      error: {
        code: AUTH_REQUIRED_CODE,
        message: 'Dashboard launch token was rejected by the server.',
        hint: 'Re-open the dashboard via `memento dashboard` to get a fresh launch URL.',
      },
    };
  }
  // The body is always a Result envelope (the server commits to
  // that shape). A network-level failure (DNS, connection
  // refused) is the only path that does not return a Result; we
  // synthesise an `ApiErr` for it so callers have a single shape
  // to handle.
  try {
    const body = (await response.json()) as ApiResult<T>;
    return body;
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: `Network or parse failure calling '${name}': ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      },
    };
  }
}

/**
 * Health-probe call against the server's liveness endpoint.
 * Distinct from `system.info` because it is a server-side
 * heartbeat, not a registry call — used by the lifecycle
 * command's "is the server up before opening the browser"
 * check, and by tests.
 */
export async function callHealth(): Promise<ApiResult<{ status: string; uiBundled: boolean }>> {
  const response = await fetch('/api/health', { headers: authHeaders() });
  return response.json() as Promise<ApiResult<{ status: string; uiBundled: boolean }>>;
}
