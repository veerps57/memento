// `@psraghuveer/memento-dashboard` server entry.
//
// Public surface: `createDashboardServer({ app, ctx })` returns a
// Hono app the lifecycle command binds to a port via
// `@hono/node-server`. The app:
//
//   1. Serves the prebuilt UI bundle at `/` (HTML + JS + CSS).
//   2. Exposes `/api/commands/*` — a generic registry-over-HTTP
//      surface that mirrors `executeCommand(...)` exactly.
//   3. Exposes `/api/health` — a one-byte liveness probe used by
//      tests and the lifecycle command's open-browser readiness
//      check.
//
// This module is the only thing the CLI's `memento dashboard`
// lifecycle command imports from this package. The UI source
// (under `src/ui/`) is built separately by Vite into
// `dist-ui/` and is loaded by the browser, never by Node.
//
// Per ADR-0018, the `/api/*` surface is a private contract
// between this server and its own UI. Downstream tools must not
// depend on it; the registry remains the only documented
// programmatic surface.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { CommandContext, CommandRegistry } from '@psraghuveer/memento-core';
import { Hono } from 'hono';

import { createCommandRouter } from './commands.js';
import { sameOriginGuard } from './security.js';
import { resolveDashboardUiDir } from './static.js';

export { resolveDashboardUiDir } from './static.js';
export { httpStatusForError } from './commands.js';

export interface CreateDashboardServerOptions {
  /** Active command registry (typically `app.registry` from `MementoApp`). */
  readonly registry: CommandRegistry;
  /** Actor stamped on every audit event the dashboard's commands emit. */
  readonly ctx: CommandContext;
  /**
   * Optional override for the UI bundle directory. Defaults to
   * the result of {@link resolveDashboardUiDir}. Tests override
   * to point at a fixture directory.
   */
  readonly uiDir?: string | null;
}

/**
 * Build the dashboard server. Returns a Hono app the caller
 * binds via `@hono/node-server`'s `serve()`.
 */
export function createDashboardServer(options: CreateDashboardServerOptions): Hono {
  const { registry, ctx } = options;
  const uiDir = options.uiDir === undefined ? resolveDashboardUiDir() : options.uiDir;

  const app = new Hono();

  app.use('*', sameOriginGuard());

  app.get('/api/health', (c) =>
    c.json({ ok: true, value: { status: 'ok', uiBundled: uiDir !== null } }),
  );

  app.route('/api/commands', createCommandRouter({ registry, ctx }));

  // Static UI. When the bundle is present, serve it from the
  // root path; SPA-style 404 → index.html for client-side
  // routing. When the bundle is absent (dev install before the
  // first `pnpm build`), serve a small HTML page explaining the
  // situation rather than letting the lifecycle command open
  // the browser to a 404.
  //
  // We do NOT use `@hono/node-server`'s `serveStatic` here: it
  // builds file paths via `addCurrentDirPrefix(...)` against
  // `process.cwd()`, which silently breaks when `root` is the
  // absolute path we hand it. Instead we resolve the request
  // path against `uiDir` ourselves, with a `..` traversal guard
  // so a probe like `GET /../../etc/passwd` cannot escape the
  // bundle directory.
  if (uiDir !== null) {
    app.get('*', (c) => serveBundle(c, uiDir));
  } else {
    app.get('*', (c) => c.html(missingBundleHtml(), 503));
  }

  return app;
}

/**
 * Serve a request from the built UI bundle directory.
 *
 * Resolution order:
 *   1. If the request path maps to an existing file under
 *      `uiDir`, stream it with the right `Content-Type`.
 *   2. Otherwise (client-side route, missing asset), serve
 *      `uiDir/index.html` so the SPA can render its own 404.
 *
 * Path safety: we resolve the candidate path with
 * `path.resolve(uiDir, requestPath)` and reject anything that
 * does not stay within `uiDir`. This handles `..` segments and
 * URL-encoded variants because the resolver normalises the
 * result before our containment check.
 */
async function serveBundle(c: import('hono').Context, uiDir: string): Promise<Response> {
  const requestPath = decodeRequestPath(c.req.path);
  if (requestPath === null) {
    return serveSpaFallback(uiDir);
  }
  const candidate = path.resolve(uiDir, requestPath);
  // Containment guard: candidate must be `uiDir` itself or a
  // descendant. `path.relative` returns a string starting with
  // `..` when the candidate escapes the root.
  const rel = path.relative(uiDir, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return serveSpaFallback(uiDir);
  }
  if (existsSync(candidate)) {
    const stats = statSync(candidate);
    if (stats.isFile()) {
      return streamFile(c, candidate, stats.size);
    }
  }
  return serveSpaFallback(uiDir);
}

/**
 * Strip the leading slash and reject the empty path so the
 * caller falls through to `index.html`. Returns `null` on a
 * decode failure (malformed `%XX`).
 */
function decodeRequestPath(reqPath: string): string | null {
  try {
    const decoded = decodeURIComponent(reqPath);
    const trimmed = decoded.replace(/^\/+/, '');
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

function serveSpaFallback(uiDir: string): Response {
  try {
    const html = readFileSync(path.resolve(uiDir, 'index.html'), 'utf8');
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch {
    return new Response('UI bundle not found.', { status: 500 });
  }
}

function streamFile(c: import('hono').Context, filePath: string, size: number): Response {
  const stream = createReadStream(filePath);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(chunk));
      stream.on('end', () => controller.close());
      stream.on('error', (err: Error) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
  c.header('Content-Type', mimeTypeFor(filePath));
  c.header('Content-Length', String(size));
  return c.body(body, 200);
}

/**
 * Minimal extension → MIME map covering the file types Vite
 * emits into `dist-ui/`. Anything else falls back to
 * `application/octet-stream`, which the browser handles fine
 * for the few unusual cases (sourcemaps, .map files).
 */
function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Tiny self-contained HTML emitted when the UI bundle hasn't
 * been built. Avoids the bad UX of "lifecycle command opened the
 * browser to a 404." Reads the same way the rest of the
 * dashboard will (terminal-flavoured, monospace, dark default)
 * so it doesn't feel like a different product.
 */
function missingBundleHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>memento dashboard — bundle not built</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; min-height: 100vh;
        display: flex; align-items: center; justify-content: center;
        background: #0E0E10; color: #E6E6E6;
        font-family: ui-monospace, "Geist Mono", "JetBrains Mono", monospace;
        font-size: 14px; line-height: 1.6;
        padding: 2rem;
      }
      .card { max-width: 36rem; }
      h1 { font-size: 1rem; letter-spacing: 0.04em; margin: 0 0 1rem; }
      h1 span { color: #E8B86C; }
      pre {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        padding: 1rem; border-radius: 4px;
        overflow-x: auto; margin: 0.5rem 0 1rem;
      }
      .muted { color: #7A7A7A; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>memento <span>dashboard</span> — bundle not built</h1>
      <p>The dashboard server is running, but the UI bundle is missing from this install.</p>
      <p class="muted">To build it from a clone:</p>
      <pre>pnpm -F @psraghuveer/memento-dashboard build</pre>
      <p class="muted">
        Then restart <code>memento dashboard</code>. If you installed via npm and
        see this page, please file an issue — the bundle should ship in the
        package tarball.
      </p>
    </div>
  </body>
</html>`;
}
