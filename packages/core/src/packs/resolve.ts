// Pack source resolver.
//
// Three resolver shapes — bundled directory, local file, HTTPS URL
// — sit behind a single {@link PackSourceResolver} interface. The
// install / preview commands take a `PackSource` (a tagged union)
// and dispatch to the matching resolver. Tests inject a
// `MapResolver` fixture; the engine never reaches the network or
// disk on its own.
//
// The integrity rules — re-stamp owner, re-scrub, refuse-on-drift,
// reserved tag prefix, deterministic clientToken — are enforced
// downstream of resolution. Resolution itself is purely "fetch the
// raw bytes"; size caps and timeouts apply here, content
// validation runs in {@link parsePackManifest}.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackId, PackVersion } from '@psraghuveer/memento-schema';

/**
 * Tagged union over the three install-time pack origins. The
 * registry command reads a CLI / MCP arg and constructs one of
 * these; the resolver's `resolve` decides what to read.
 *
 * - `bundled` — pull from `packs.bundledRegistryPath`. `version`
 *   is optional; when omitted the resolver picks the highest
 *   semver under `packs/<id>/` (ADR-0020 §Bundled).
 * - `file`    — read from a local filesystem path. Used for
 *   `pack install --from-file <path>` and for pack authoring
 *   round-trips.
 * - `url`     — fetch from an HTTPS URL. HTTPS-only, no redirect
 *   following, capped at `packs.maxPackSizeBytes` and timed out
 *   at `packs.urlFetchTimeoutMs`. Disabled entirely when
 *   `packs.allowRemoteUrls` is `false`.
 */
export type PackSource =
  | { readonly type: 'bundled'; readonly id: PackId; readonly version?: PackVersion }
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'url'; readonly url: string };

/**
 * Resolver outcome — either the raw YAML and an opaque label
 * identifying where it came from (for diagnostics) or a
 * structured failure with a human-readable error message.
 */
export type PackResolveResult =
  | { readonly ok: true; readonly raw: string; readonly sourceLabel: string }
  | { readonly ok: false; readonly error: string; readonly code: PackResolveErrorCode };

export type PackResolveErrorCode =
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'REMOTE_DISABLED'
  | 'INVALID_URL'
  | 'IO_ERROR';

export interface PackSourceResolver {
  resolve(source: PackSource): Promise<PackResolveResult>;
}

export interface DefaultResolverOptions {
  /**
   * Base directory containing bundled packs. Layout is
   * `<bundledRoot>/<id>/v<version>.yaml`. From config key
   * `packs.bundledRegistryPath`. `null` means "no bundled root
   * configured" — bundled lookups fail with `NOT_FOUND`.
   */
  readonly bundledRoot: string | null;
  /**
   * Master switch from `packs.allowRemoteUrls`. When false,
   * URL resolution returns `REMOTE_DISABLED`.
   */
  readonly allowRemoteUrls: boolean;
  /**
   * Per-request timeout in milliseconds, from
   * `packs.urlFetchTimeoutMs`. Applies to both URL fetches
   * and (for symmetry with future streaming bundled stores)
   * to file reads.
   */
  readonly urlFetchTimeoutMs: number;
  /**
   * Maximum body size in bytes from `packs.maxPackSizeBytes`.
   * Enforced for URL fetches and local files alike.
   */
  readonly maxPackSizeBytes: number;
  /**
   * Optional fetch implementation, for tests. Defaults to the
   * global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional listing for the bundled root, for tests. Defaults
   * to `node:fs` reads. Returning the raw YAML for a (`id`,
   * `version`) pair lets tests sidestep the filesystem entirely.
   */
  readonly bundledOverride?: (
    id: PackId,
    version: PackVersion | undefined,
  ) => Promise<PackResolveResult>;
}

/**
 * Default {@link PackSourceResolver} — wires together the three
 * source shapes against `node:fs` and `globalThis.fetch`. Tests
 * pass `bundledOverride` and/or `fetchImpl` to redirect IO.
 */
export function createDefaultPackSourceResolver(opts: DefaultResolverOptions): PackSourceResolver {
  return {
    async resolve(source: PackSource): Promise<PackResolveResult> {
      switch (source.type) {
        case 'bundled':
          return resolveBundled(source.id, source.version, opts);
        case 'file':
          return resolveFile(source.path, opts);
        case 'url':
          return resolveUrl(source.url, opts);
      }
    },
  };
}

async function resolveBundled(
  id: PackId,
  version: PackVersion | undefined,
  opts: DefaultResolverOptions,
): Promise<PackResolveResult> {
  if (opts.bundledOverride) {
    return opts.bundledOverride(id, version);
  }
  if (!opts.bundledRoot) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      error: `no bundled pack registry configured (set "packs.bundledRegistryPath")`,
    };
  }
  // Without a directory listing we cannot pick "the highest
  // version". For v1 we require an explicit version when reading
  // bundled packs to keep the resolver dependency-free; the
  // command layer is welcome to scan the directory and pick a
  // version, then call us with the resolved version.
  if (!version) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      error: `bundled pack ${id} requires a version when no override is supplied`,
    };
  }
  const path = join(opts.bundledRoot, id, `v${version}.yaml`);
  return resolveFile(path, opts);
}

async function resolveFile(path: string, opts: DefaultResolverOptions): Promise<PackResolveResult> {
  let raw: string;
  try {
    const buf = await readFile(path);
    if (buf.byteLength > opts.maxPackSizeBytes) {
      return {
        ok: false,
        code: 'TOO_LARGE',
        error: `pack file exceeds ${opts.maxPackSizeBytes} bytes (actual: ${buf.byteLength})`,
      };
    }
    raw = buf.toString('utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { ok: false, code: 'NOT_FOUND', error: `pack file not found: ${path}` };
    }
    return { ok: false, code: 'IO_ERROR', error: `${e.code ?? 'IO'}: ${e.message}` };
  }
  return { ok: true, raw, sourceLabel: `file:${path}` };
}

async function resolveUrl(url: string, opts: DefaultResolverOptions): Promise<PackResolveResult> {
  if (!opts.allowRemoteUrls) {
    return {
      ok: false,
      code: 'REMOTE_DISABLED',
      error: 'remote pack URLs are disabled (`packs.allowRemoteUrls` is false)',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'INVALID_URL', error: `not a valid URL: ${url}` };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'INVALID_URL',
      error: `pack URLs must use https:// (got ${parsed.protocol})`,
    };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.urlFetchTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === 'AbortError') {
      return {
        ok: false,
        code: 'TIMEOUT',
        error: `pack URL fetch exceeded ${opts.urlFetchTimeoutMs}ms`,
      };
    }
    return { ok: false, code: 'IO_ERROR', error: `URL fetch failed: ${(err as Error).message}` };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    return {
      ok: false,
      code: 'IO_ERROR',
      error: `pack URL responded with HTTP ${response.status}`,
    };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > opts.maxPackSizeBytes) {
      return {
        ok: false,
        code: 'TOO_LARGE',
        error: `pack URL response exceeds ${opts.maxPackSizeBytes} bytes`,
      };
    }
    return { ok: true, raw: text, sourceLabel: `url:${url}` };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > opts.maxPackSizeBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort cancellation; ignore upstream errors
      }
      return {
        ok: false,
        code: 'TOO_LARGE',
        error: `pack URL response exceeds ${opts.maxPackSizeBytes} bytes`,
      };
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    ok: true,
    raw: new TextDecoder('utf-8').decode(merged),
    sourceLabel: `url:${url}`,
  };
}
