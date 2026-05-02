// Dashboard server route tests.
//
// Spins up an in-memory `MementoApp` (mirroring the pattern in
// `packages/cli/test/`) and exercises the Hono app via its
// `fetch` handler — no actual port binding needed. This proves
// the wiring against the real registry without process-level
// state.
//
// What we pin
// -----------
//
// 1. `/api/health` returns a structured Result envelope.
// 2. `/api/commands/system.info` round-trips through
//    `executeCommand` and returns the registry's exact output
//    shape (counts by status, vector flag, version, dbPath,
//    embedder details).
// 3. POST without an `Origin` header is rejected — the CSRF
//    guard from `security.ts`.
// 4. POST with a non-localhost `Origin` is rejected.
// 5. POST to an unknown command name returns NOT_FOUND.
// 6. Body-parse failures return INVALID_INPUT.

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

const ALLOWED_ORIGIN = 'http://127.0.0.1:51234';

describe('createDashboardServer', () => {
  let app: Awaited<ReturnType<typeof createMementoApp>>;
  let serverApp: ReturnType<typeof createDashboardServer>;

  beforeEach(async () => {
    app = await createAppNoVector({ dbPath: ':memory:' });
    serverApp = createDashboardServer({
      registry: app.registry,
      ctx: { actor: { type: 'cli' } },
      // Suppress the static handler — we're testing the API.
      uiDir: null,
    });
  });

  afterEach(() => {
    app.close();
  });

  describe('GET /api/health', () => {
    it('returns ok with bundle status', async () => {
      const res = await serverApp.fetch(new Request('http://localhost/api/health'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        value: { status: string; uiBundled: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.value.status).toBe('ok');
      // We passed `uiDir: null` to the constructor, so the
      // health route reports the bundle as missing.
      expect(body.value.uiBundled).toBe(false);
    });
  });

  describe('POST /api/commands/system.info', () => {
    it('round-trips through the registry', async () => {
      const res = await serverApp.fetch(
        new Request('http://localhost/api/commands/system.info', {
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
      // The shape must match `system.info`'s output schema
      // exactly — the dashboard server is a thin pass-through.
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

  describe('CSRF guard on mutating requests', () => {
    it('rejects POST without an Origin header', async () => {
      const res = await serverApp.fetch(
        new Request('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_INPUT');
    });

    it('rejects POST with a non-localhost Origin', async () => {
      const res = await serverApp.fetch(
        new Request('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://evil.example.com',
          },
          body: '{}',
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_INPUT');
    });

    it('accepts POST with a localhost Origin', async () => {
      // Verifies the guard does not over-block — same shape as
      // the round-trip test, just confirming Origin acceptance
      // is not the failure mode.
      const res = await serverApp.fetch(
        new Request('http://localhost/api/commands/system.info', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:5173',
          },
          body: '{}',
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('returns NOT_FOUND for an unknown command', async () => {
      const res = await serverApp.fetch(
        new Request('http://localhost/api/commands/does.not.exist', {
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
        new Request('http://localhost/api/commands/system.info', {
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
      // `system.info` accepts no input; the API client may send
      // an empty body rather than a literal `{}`. The router
      // must coerce that to an object so `executeCommand` does
      // not get tripped up by the parse step.
      const res = await serverApp.fetch(
        new Request('http://localhost/api/commands/system.info', {
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
      // Trigger an INVALID_INPUT by passing a bad shape to a
      // strict input schema. `memory.read` requires `id`; an
      // empty object fails Zod's `min(1)` validation upstream
      // and surfaces as INVALID_INPUT in the Result envelope.
      const res = await serverApp.fetch(
        new Request('http://localhost/api/commands/memory.read', {
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

  describe('GET /api/commands listing', () => {
    it('returns every registered command for the command palette', async () => {
      const res = await serverApp.fetch(new Request('http://localhost/api/commands'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        value: ReadonlyArray<{ name: string; sideEffect: string }>;
      };
      expect(body.ok).toBe(true);
      // The exact command set is pinned by the registry parity
      // test in the CLI package; here we just assert the shape
      // and that a few canonical commands are present.
      const names = new Set(body.value.map((c) => c.name));
      expect(names.has('system.info')).toBe(true);
      expect(names.has('memory.list')).toBe(true);
      expect(names.has('memory.write')).toBe(true);
      expect(names.has('conflict.list')).toBe(true);
    });
  });

  describe('static handler when bundle is missing', () => {
    it('returns the friendly missing-bundle HTML on GET /', async () => {
      const res = await serverApp.fetch(new Request('http://localhost/'));
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain('bundle not built');
    });
  });
});

// Static handler against a real on-disk bundle directory.
//
// This is a regression suite for the bug that shipped in the
// first cut of `createDashboardServer`: we used
// `@hono/node-server`'s `serveStatic`, whose internal
// `addCurrentDirPrefix` resolves files relative to
// `process.cwd()` — so an absolute `root` argument silently
// failed to serve any asset. Symptom: blank page on load
// because `/assets/index-*.js` returned the SPA fallback HTML
// instead of JS.
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
      uiDir: bundleDir,
    });
  });

  afterEach(() => {
    app.close();
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it('serves index.html on GET /', async () => {
    const res = await serverApp.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('memento dashboard');
  });

  it('serves a hashed JS asset with the right MIME type', async () => {
    const res = await serverApp.fetch(new Request('http://localhost/assets/index-deadbeef.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    const body = await res.text();
    expect(body).toContain('sentinel');
  });

  it('serves a hashed CSS asset with the right MIME type', async () => {
    const res = await serverApp.fetch(new Request('http://localhost/assets/index-cafef00d.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('falls back to index.html for unknown SPA routes', async () => {
    const res = await serverApp.fetch(new Request('http://localhost/memory'));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('memento dashboard');
  });

  it('rejects path traversal attempts', async () => {
    // The traversal guard maps escapes to the SPA fallback. The
    // important property is that we never read a file outside
    // the bundle directory: a probe for `../package.json` must
    // not return JSON content, even though the file exists in
    // the workspace.
    const res = await serverApp.fetch(new Request('http://localhost/../package.json'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
