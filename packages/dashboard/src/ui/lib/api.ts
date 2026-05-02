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
  const response = await fetch(`/api/commands/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
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
  const response = await fetch('/api/health');
  return response.json() as Promise<ApiResult<{ status: string; uiBundled: boolean }>>;
}
