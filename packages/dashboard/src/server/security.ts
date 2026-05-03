// Authentication + same-origin guards for the dashboard server.
// See `SECURITY.md` for the project-wide threat model; this
// module owns the dashboard-specific defences.
//
// Threat model
// ------------
//
// The dashboard binds to `127.0.0.1` on a port the user controls,
// so only processes on the same machine can reach it. Two attacker
// shapes matter:
//
//   1. **Cross-origin browser tab.** A webpage in another tab in
//      the user's browser issues a cross-origin `fetch` to the
//      dashboard's localhost URL hoping to cause a destructive
//      operation (e.g. `memory.forget`). Defended by the
//      same-origin guard below — `Origin` must equal the
//      dashboard's own bound origin (exact match, not prefix).
//
//   2. **Co-resident process.** Any process running as the user
//      can connect to `127.0.0.1:<port>` and POST to the API.
//      Defended by the per-launch random token: every API call
//      must carry `Authorization: Bearer <token>` (or the legacy
//      `X-Memento-Token` header). The token is fresh per-launch,
//      kept in `sessionStorage` by the SPA, and never logged or
//      persisted. A process that did not see the launch URL
//      cannot obtain it.
//
// And one defence-in-depth layer:
//
//   3. **DNS rebinding.** A malicious public-internet origin
//      whose DNS resolves to `127.0.0.1` could in principle
//      reach the dashboard. The `Host` header on such a
//      request would be the attacker's domain. The Host
//      allowlist below rejects anything that is not exactly
//      `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`.
//
// The Origin guard, the token, and the Host guard are
// independent layers; each can fail without the others
// admitting an attack.

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const TOKEN_HEADER_PRIMARY = 'authorization';
const TOKEN_HEADER_FALLBACK = 'x-memento-token';

/**
 * Header used to ferry the launch token from the SPA back to
 * the server. The launcher embeds the token in the URL fragment
 * (`#token=…`); the SPA reads it on first load, stores it in
 * `sessionStorage`, and sends it on every API call.
 */
export const TOKEN_HEADER = TOKEN_HEADER_FALLBACK;

/**
 * Build the set of acceptable `Origin` values for the dashboard's
 * bound port. Browsers emit one of these two shapes for any
 * fetch from the dashboard's own page; anything else is a
 * cross-origin attempt.
 */
function buildAllowedOrigins(port: number): ReadonlySet<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

/**
 * Build the set of acceptable `Host` header values for the
 * dashboard's bound port. The Host header is what stops DNS
 * rebinding — every loopback name a browser might canonicalise
 * to `127.0.0.1` resolves to one of these literals.
 */
function buildAllowedHosts(port: number): ReadonlySet<string> {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    // Some agents omit the port when it is the scheme default.
    // The dashboard never uses 80 (it binds to a random port),
    // but for defence-in-depth we also accept the bare host.
  ]);
}

function denyJson(c: import('hono').Context, message: string, status: 401 | 403) {
  return c.json(
    {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message,
      },
    },
    status,
  );
}

/**
 * Constant-time equality on the launch token. The naive `===`
 * leaks the matching prefix length via timing on attacker-grade
 * setups; constant-time comparison is the standard mitigation.
 */
function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractBearer(headerValue: string | undefined): string | null {
  if (headerValue === undefined) return null;
  // Accept either bare `Bearer <token>` or just `<token>` for
  // the legacy `x-memento-token` header.
  const trimmed = headerValue.trim();
  const match = /^Bearer\s+(.+)$/iu.exec(trimmed);
  if (match !== null) {
    const value = match[1];
    if (value !== undefined) return value.trim();
    return null;
  }
  return trimmed;
}

/**
 * Middleware that:
 *   1. Rejects any request whose `Host` header is not one of
 *      `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`
 *      — closes DNS rebinding.
 *   2. On state-changing methods (POST/PUT/PATCH/DELETE),
 *      requires `Origin` to exactly match the dashboard's own
 *      origin — closes browser-tab CSRF.
 *   3. On every `/api/*` request, requires the launch token —
 *      closes co-resident-process attack.
 *
 * The static UI bundle (everything not under `/api/`) is gated
 * by the Host check only; the SPA needs to load before it can
 * present a token.
 */
export function authGuard(opts: {
  readonly port: number;
  readonly token: string;
}): MiddlewareHandler {
  const allowedOrigins = buildAllowedOrigins(opts.port);
  const allowedHosts = buildAllowedHosts(opts.port);
  const expectedToken = opts.token;
  return async (c, next) => {
    // (1) Host allowlist — every request, every method.
    const host = c.req.header('host');
    if (host === undefined || !allowedHosts.has(host.toLowerCase())) {
      return denyJson(c, `Host '${host ?? '<missing>'}' is not allowed.`, 403);
    }

    const isApi = c.req.path.startsWith('/api/');
    const isMutating =
      c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS';

    // (2) Origin exact match on mutating requests. The previous
    // implementation prefix-matched every localhost origin,
    // which let any sibling localhost web server forge requests.
    // Exact-match against the dashboard's own port closes that.
    if (isMutating) {
      const origin = c.req.header('origin');
      if (origin === undefined) {
        return denyJson(c, 'Origin header required for mutating requests.', 403);
      }
      if (!allowedOrigins.has(origin)) {
        return denyJson(
          c,
          `Origin '${origin}' is not allowed; the dashboard accepts only its own origin.`,
          403,
        );
      }
    }

    // (3) Token gate on every API call (read or write).
    if (isApi) {
      const authHeader = c.req.header(TOKEN_HEADER_PRIMARY);
      const fallback = c.req.header(TOKEN_HEADER_FALLBACK);
      const provided = extractBearer(authHeader) ?? extractBearer(fallback);
      if (provided === null || !tokenEquals(provided, expectedToken)) {
        return denyJson(
          c,
          'Authentication required: send the launch token in the Authorization header.',
          401,
        );
      }
    }

    return next();
  };
}
