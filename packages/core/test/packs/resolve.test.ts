import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackIdSchema, PackVersionSchema } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultPackSourceResolver } from '../../src/packs/resolve.js';

const opts = (override: Partial<Parameters<typeof createDefaultPackSourceResolver>[0]> = {}) =>
  createDefaultPackSourceResolver({
    bundledRoot: null,
    allowRemoteUrls: true,
    urlFetchTimeoutMs: 1000,
    maxPackSizeBytes: 1024,
    ...override,
  });

const tempRoots: string[] = [];

afterEach(async () => {
  // Clean up any temp directories we created. Best-effort —
  // failures here just leak into /tmp and the OS reclaims later.
  tempRoots.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memento-pack-test-'));
  tempRoots.push(dir);
  return dir;
}

describe('FileResolver', () => {
  it('reads an existing file and returns its UTF-8 content', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'pack.yaml');
    await writeFile(path, 'format: memento-pack/v1\n');
    const r = opts();
    const result = await r.resolve({ type: 'file', path });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.raw).toBe('format: memento-pack/v1\n');
      expect(result.sourceLabel).toContain('file:');
    }
  });

  it('returns NOT_FOUND for a missing path', async () => {
    const r = opts();
    const result = await r.resolve({
      type: 'file',
      path: '/nonexistent-memento-test-path/pack.yaml',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  it('returns TOO_LARGE when the file exceeds maxPackSizeBytes', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'big.yaml');
    await writeFile(path, 'a'.repeat(2048));
    const r = opts({ maxPackSizeBytes: 512 });
    const result = await r.resolve({ type: 'file', path });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TOO_LARGE');
    }
  });
});

describe('BundledResolver', () => {
  it('returns NOT_FOUND when bundledRoot is null and no override is supplied', async () => {
    const r = opts({ bundledRoot: null });
    const result = await r.resolve({
      type: 'bundled',
      id: PackIdSchema.parse('rust-axum'),
      version: PackVersionSchema.parse('1.0.0'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('refuses bundled lookups without an explicit version (v1 contract)', async () => {
    const dir = await makeTempDir();
    const r = opts({ bundledRoot: dir });
    const result = await r.resolve({
      type: 'bundled',
      id: PackIdSchema.parse('rust-axum'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('reads from <bundledRoot>/<id>/v<version>.yaml when present', async () => {
    const dir = await makeTempDir();
    const packDir = join(dir, 'rust-axum');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'v1.0.0.yaml'), 'format: memento-pack/v1\n');
    const r = opts({ bundledRoot: dir });
    const result = await r.resolve({
      type: 'bundled',
      id: PackIdSchema.parse('rust-axum'),
      version: PackVersionSchema.parse('1.0.0'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.raw).toContain('memento-pack/v1');
  });

  it('honours bundledOverride for tests', async () => {
    const r = opts({
      bundledOverride: async () => ({ ok: true, raw: 'overridden', sourceLabel: 'test' }),
    });
    const result = await r.resolve({
      type: 'bundled',
      id: PackIdSchema.parse('foo'),
      version: PackVersionSchema.parse('1.0.0'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.raw).toBe('overridden');
  });
});

describe('UrlResolver', () => {
  it('refuses when allowRemoteUrls is false', async () => {
    const r = opts({ allowRemoteUrls: false });
    const result = await r.resolve({
      type: 'url',
      url: 'https://example.com/pack.yaml',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('REMOTE_DISABLED');
  });

  it('rejects http:// (https only)', async () => {
    const r = opts();
    const result = await r.resolve({
      type: 'url',
      url: 'http://example.com/pack.yaml',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_URL');
  });

  it('rejects malformed URLs', async () => {
    const r = opts();
    const result = await r.resolve({ type: 'url', url: 'not a url' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_URL');
  });

  it('uses fetchImpl override and returns the response body', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('format: memento-pack/v1\n', { status: 200 });
    const r = opts({ fetchImpl });
    const result = await r.resolve({
      type: 'url',
      url: 'https://example.com/pack.yaml',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.raw).toContain('memento-pack/v1');
  });

  it('returns IO_ERROR for non-2xx responses', async () => {
    const fetchImpl: typeof fetch = async () => new Response('not found', { status: 404 });
    const r = opts({ fetchImpl });
    const result = await r.resolve({
      type: 'url',
      url: 'https://example.com/missing.yaml',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('IO_ERROR');
      expect(result.error).toContain('404');
    }
  });

  it('returns TIMEOUT when the fetch is aborted', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    const r = opts({ fetchImpl, urlFetchTimeoutMs: 5 });
    const result = await r.resolve({
      type: 'url',
      url: 'https://example.com/slow.yaml',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TIMEOUT');
      expect(result.error).toMatch(/exceeded/);
    }
  });

  it('returns TOO_LARGE when the response exceeds the byte cap', async () => {
    const big = 'a'.repeat(2048);
    const fetchImpl: typeof fetch = async () => new Response(big, { status: 200 });
    const r = opts({ fetchImpl, maxPackSizeBytes: 512 });
    const result = await r.resolve({
      type: 'url',
      url: 'https://example.com/big.yaml',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TOO_LARGE');
  });
});
