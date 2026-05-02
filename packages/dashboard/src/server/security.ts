// Same-origin guard middleware for the dashboard server.
//
// Threat model
// ------------
//
// The dashboard binds to `127.0.0.1` on a port the user controls,
// so only processes on the same machine can reach it. The realistic
// attack surface is therefore CSRF — a webpage in another tab in
// the user's browser issues a cross-origin `fetch` to the
// dashboard's localhost URL hoping to cause a destructive operation
// (e.g. `memory.forget`).
//
// Defense
// -------
//
// On every state-changing request, require the `Origin` header to
// match the dashboard's own origin (always `http://127.0.0.1:<port>`
// or `http://localhost:<port>`). Cross-origin browser requests carry
// an `Origin` header set by the browser; the server compares.
//
// Read-only requests (GET) and the static file routes are not
// gated — leaking the existence of the dashboard or a memory's
// content to a probing webpage is no worse than what Memento
// already trusts the local environment with, and the simplicity
// of "static + GETs are open, mutations are gated" is worth the
// small surface widening.
//
// Future
// ------
//
// A per-session CSRF token written into the served HTML and
// echoed on every API call closes the residual gap (a server
// that mishandles a Same-Origin probe). Not in v0.

import type { MiddlewareHandler } from 'hono';

const ALLOWED_ORIGIN_PREFIXES = ['http://127.0.0.1:', 'http://localhost:'] as const;

/**
 * Middleware that rejects mutating requests whose `Origin` header
 * is missing or does not match a localhost prefix. GETs pass
 * through unconditionally.
 */
export function sameOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
      return next();
    }
    const origin = c.req.header('origin');
    if (origin === undefined) {
      // Browser-issued POST without Origin is unusual but not
      // impossible (some tools strip it). Block by default — the
      // dashboard's own UI always sends Origin via fetch().
      return c.json(
        {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Origin header required for mutating requests.',
          },
        },
        403,
      );
    }
    const matches = ALLOWED_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix));
    if (!matches) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `Origin '${origin}' is not allowed; the dashboard accepts only localhost origins.`,
          },
        },
        403,
      );
    }
    return next();
  };
}
