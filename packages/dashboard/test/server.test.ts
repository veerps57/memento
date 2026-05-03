// Dashboard server route tests.
//
// Spins up an in-memory `MementoApp` (mirroring the pattern in
// `packages/cli/test/`) and exercises the Hono app via its
// `fetch` handler — no actual port binding needed. This proves
// the wiring against the real registry without process-level
// state.
//
// Three independent defence layers are pinned here (see the
// module header in `src/server/security.ts` for the threat
// model):
//
// 1. Per-launch token (Authorization header) on every `/api/*`
//    request.
// 2. Same-origin guard with EXACT-PORT match on mutating
//    requests.
// 3. Host-header allowlist — every request must carry a Host
//    that resolves to the bound port.
//
// Plus the dashboard-surface filter on `/api/commands`: only
// commands whose `surfaces` array includes `'dashboard'` are
// admitted; the rest return INVALID_INPUT pointing at the CLI.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type CreateMementoAppOptions, createMementoApp } from '@psraghuveer/memento-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDashboardServer } from '../src/server/index.js';

// `retrieval.vector.enabled` defaults to true; tests that don't
// wire an embedder must turn it off so `system.info` doesn't
// short-circuit on the missing provider.
const createAppNoVector: typeof createMementoApp = (opts: CreateMementoAppOptions) =>
  createMementoApp({
    ...opts,
    configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
  });

const TEST_TOKEN = 'test-token-32-bytes-of-entropy-here';
const TEST_PORT = 51234;
const ALLOWED_ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const ALLOWED_HOST = `127.0.0.1:${TEST_PORT}`;
const AUTH = `Bearer ${TEST_TOKEN}`;

/**
 * Build a Request that satisfies the Host + auth gates so each
 * test can focus on the property under test rather than every
 * test having to remember every header. Per-test overrides win.
 */
function authedRequest(
  url: string,
  init: RequestInit & { skipAuth?: boolean; skipHost?: boolean } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.skipAuth !== true) headers.set('authorization', AUTH);
  if (init.skipHost !== true && !headers.has('host')) headers.set('host', ALLOWED_HOST);
  // Rewrite the URL host to match the bound port so the
  // Hono router's `c.req.header('host')` agrees with the
  // explicit `host` header in `headers`. The two should be
  // consistent on real traffic.
  const u = new URL(url);
  u.host = ALLOWED_HOST;
  return new Request(u.toString(), { ...init, headers });
}

describe('createDashboardServer', () => {
  let app: Awaited<ReturnType<typeof createMementoApp>>;
  let serverApp: ReturnType<typeof createDashboardServer>;

  beforeEach(async () => {
    app = await createAppNoVector({ dbPath: ':memory:' });
    serverApp = createDashboardServer({
      registry: app.registry,
      ctx: { actor: { type: 'cli' } },
      token: TEST_TOKEN,
      port: TEST_PORT,
      // Suppress the static handler — we're testing the API.
      uiDir: null,
    });
  });

  afterEach(() => {
    app.close();
  });

  describe('GET /api/health', () => {
    it('returns ok with bundle status when authenticated', async () => {
      const res = await serverApp.fetch(authedRequest('http://localhost/api/health'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        value: { status: string; uiBundled: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.value.status).toBe('ok');
      expect(body.value.uiBundled).toBe(false);
    });
  });

  describe('POST /api/commands/system.info', () => {
    it('round-trips through the registry', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ALLOWED_ORIGIN,
          },
          body: '{}',
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        value: {
          version: string;
          schemaVersion: number;
          dbPath: string | null;
          vectorEnabled: boolean;
          embedder: { configured: boolean; model: string; dimension: number };
          counts: { active: number; archived: number; forgotten: number; superseded: number };
        };
      };
      expect(body.ok).toBe(true);
      expect(body.value.vectorEnabled).toBe(false);
      expect(body.value.counts).toEqual({
        active: 0,
        archived: 0,
        forgotten: 0,
        superseded: 0,
      });
      expect(body.value.embedder.configured).toBe(false);
    });
  });

  describe('Per-launch token (Authorization header)', () => {
    it('rejects /api/* without an Authorization header', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/health', { skipAuth: true }),
      );
      expect(res.status).toBe(401);
    });

    it('rejects /api/* with the wrong token', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/health', {
          skipAuth: true,
          headers: { authorization: 'Bearer wrong-token' },
        }),
      );
      expect(res.status).toBe(401);
    });

    it('accepts the legacy x-memento-token header', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/health', {
          skipAuth: true,
          headers: { 'x-memento-token': TEST_TOKEN },
        }),
      );
      expect(res.status).toBe(200);
    });

    it('compares tokens of differing length without timing leak (smoke test)', async () => {
      // We cannot meaningfully assert timing here, but we can
      // confirm a length-mismatched token is rejected (the
      // `tokenEquals` helper short-circuits on length).
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/health', {
          skipAuth: true,
          headers: { authorization: 'Bearer short' },
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  describe('CSRF guard — exact-origin match on mutating requests', () => {
    it('rejects POST without an Origin header', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(res.status).toBe(403);
    });

    it('rejects POST with a non-localhost Origin', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://evil.example.com',
          },
          body: '{}',
        }),
      );
      expect(res.status).toBe(403);
    });

    it('rejects POST with a localhost Origin on a different port', async () => {
      // The guard requires the EXACT bound port — a sibling
      // localhost web server (e.g. a Vite dev server on 5173 or
      // another local app) cannot forge requests against the
      // dashboard.
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:5173',
          },
          body: '{}',
        }),
      );
      expect(res.status).toBe(403);
    });

    it('accepts POST with the dashboard origin (127.0.0.1)', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ALLOWED_ORIGIN,
          },
          body: '{}',
        }),
      );
      expect(res.status).toBe(200);
    });

    it('accepts POST with the dashboard origin (localhost)', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: `http://localhost:${TEST_PORT}`,
          },
          body: '{}',
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe('Host header allowlist (DNS rebinding defence)', () => {
    it('rejects a request whose Host is an attacker-controlled domain', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/health', {
          skipHost: true,
          headers: { host: 'evil.example.com', authorization: AUTH },
        }),
      );
      expect(res.status).toBe(403);
    });

    it('rejects a request whose Host has the wrong port', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/health', {
          skipHost: true,
          headers: { host: '127.0.0.1:5173', authorization: AUTH },
        }),
      );
      expect(res.status).toBe(403);
    });

    it('accepts the IPv6 loopback host shape', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/health', {
          skipHost: true,
          headers: { host: `[::1]:${TEST_PORT}`, authorization: AUTH },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe('Dashboard surface filter', () => {
    it('rejects a command that exists but is not on the dashboard surface', async () => {
      // `memory.write` is mcp+cli-only; the dashboard's UI does
      // not need it. Calling it via the dashboard API must fail
      // with a clear message pointing at the CLI alternative.
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/memory.write', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
          body: '{}',
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_INPUT');
      expect(body.error.message).toMatch(/not exposed on the dashboard surface/u);
    });

    it('lists only dashboard-surface commands on GET /api/commands', async () => {
      const res = await serverApp.fetch(authedRequest('http://localhost/api/commands'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        value: ReadonlyArray<{ name: string; surfaces: readonly string[] }>;
      };
      expect(body.ok).toBe(true);
      const names = new Set(body.value.map((c) => c.name));
      // UI-used commands are present.
      expect(names.has('system.info')).toBe(true);
      expect(names.has('memory.list')).toBe(true);
      expect(names.has('memory.read')).toBe(true);
      expect(names.has('config.list')).toBe(true);
      expect(names.has('conflict.list')).toBe(true);
      // Non-dashboard commands are absent.
      expect(names.has('memory.write')).toBe(false);
      expect(names.has('memory.supersede')).toBe(false);
      expect(names.has('memory.set_embedding')).toBe(false);
      expect(names.has('compact.run')).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns NOT_FOUND for a genuinely unknown command', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/does.not.exist', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
          body: '{}',
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns INVALID_INPUT for malformed JSON', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
          body: '{not valid',
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_INPUT');
    });

    it('treats an empty body as {} (zero-arg commands)', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
          body: '',
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it('maps INVALID_INPUT from the registry to HTTP 400', async () => {
      const res = await serverApp.fetch(
        authedRequest('http://localhost/api/commands/memory.read', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
          body: '{}',
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_INPUT');
    });
  });

  describe('static handler when bundle is missing', () => {
    it('returns the friendly missing-bundle HTML on GET /', async () => {
      const res = await serverApp.fetch(authedRequest('http://localhost/'));
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain('bundle not built');
    });
  });
});

// Static handler against a real on-disk bundle directory.
describe('createDashboardServer static handler', () => {
  let app: Awaited<ReturnType<typeof createMementoApp>>;
  let serverApp: ReturnType<typeof createDashboardServer>;
  let bundleDir: string;

  beforeEach(async () => {
    app = await createAppNoVector({ dbPath: ':memory:' });
    bundleDir = mkdtempSync(path.join(tmpdir(), 'memento-dashboard-bundle-'));
    mkdirSync(path.join(bundleDir, 'assets'), { recursive: true });
    writeFileSync(
      path.join(bundleDir, 'index.html'),
      '<!doctype html><html><body>memento dashboard</body></html>',
    );
    writeFileSync(
      path.join(bundleDir, 'assets', 'index-deadbeef.js'),
      'export const sentinel = 1;\n',
    );
    writeFileSync(path.join(bundleDir, 'assets', 'index-cafef00d.css'), 'body{margin:0}\n');
    serverApp = createDashboardServer({
      registry: app.registry,
      ctx: { actor: { type: 'cli' } },
      token: TEST_TOKEN,
      port: TEST_PORT,
      uiDir: bundleDir,
    });
  });

  afterEach(() => {
    app.close();
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it('serves index.html on GET /', async () => {
    const res = await serverApp.fetch(authedRequest('http://localhost/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('memento dashboard');
  });

  it('serves a hashed JS asset with the right MIME type', async () => {
    const res = await serverApp.fetch(authedRequest('http://localhost/assets/index-deadbeef.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    const body = await res.text();
    expect(body).toContain('sentinel');
  });

  it('serves a hashed CSS asset with the right MIME type', async () => {
    const res = await serverApp.fetch(authedRequest('http://localhost/assets/index-cafef00d.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('falls back to index.html for unknown SPA routes', async () => {
    const res = await serverApp.fetch(authedRequest('http://localhost/memory'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('memento dashboard');
  });

  it('rejects path traversal attempts', async () => {
    const res = await serverApp.fetch(authedRequest('http://localhost/../package.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('emits secure response headers (CSP, nosniff, X-Frame-Options)', async () => {
    const res = await serverApp.fetch(authedRequest('http://localhost/'));
    // The exact CSP string is determined by Hono's secureHeaders;
    // assert the headers we care about are present and have a
    // sensible shape rather than pinning the entire string.
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toMatch(/no-referrer/);
  });
});
