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

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackId, PackVersion } from '@psraghuveer/memento-schema';

/**
 * Tagged union over the three install-time pack origins. The
 * registry command reads a CLI / MCP arg and constructs one of
 * these; the resolver's `resolve` decides what to read.
 *
 * - `bundled` — pull from `packs.bundledRegistryPath`. `version`
 *   is optional; when omitted the resolver scans
 *   `<bundledRoot>/<id>/v*.yaml`, parses each filename as semver,
 *   and picks the highest (stable beats prerelease per semver §11).
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
  let resolvedVersion: PackVersion;
  if (version) {
    resolvedVersion = version;
  } else {
    // Pick the highest semver under `<bundledRoot>/<id>/v*.yaml`.
    // Stable releases beat prereleases at the same MAJOR.MINOR.PATCH
    // (per semver §11). The directory may also contain a README or
    // other files; non-`v<semver>.yaml` entries are ignored.
    const picked = await pickHighestVersion(join(opts.bundledRoot, id));
    if (picked === null) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        error: `bundled pack ${id} not found at ${opts.bundledRoot}/${id}`,
      };
    }
    resolvedVersion = picked;
  }
  const path = join(opts.bundledRoot, id, `v${resolvedVersion}.yaml`);
  return resolveFile(path, opts);
}

/**
 * Scan `<dir>/v*.yaml` for valid semver filenames and return the
 * highest. Returns `null` if the directory is missing, contains
 * no matching files, or every match has an invalid semver.
 *
 * Stable releases beat prereleases at the same MAJOR.MINOR.PATCH;
 * within prereleases, identifiers compare per semver §11.
 */
async function pickHighestVersion(dir: string): Promise<PackVersion | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const candidates: { version: string; tuple: SemverTuple }[] = [];
  for (const entry of entries) {
    const match = /^v(.+)\.yaml$/.exec(entry);
    if (!match) continue;
    const versionString = match[1] as string;
    const tuple = parseSemverTuple(versionString);
    if (tuple === null) continue;
    candidates.push({ version: versionString, tuple });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareSemver(b.tuple, a.tuple));
  return candidates[0]?.version as PackVersion;
}

/**
 * Tuple form of a semver string for comparison. The fourth slot is
 * the prerelease identifier list (`-rc.1` → `['rc', '1']`); empty
 * array marks a stable release.
 */
type SemverTuple = readonly [number, number, number, readonly string[]];

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(.+))?$/;

function parseSemverTuple(version: string): SemverTuple | null {
  const match = SEMVER_RE.exec(version);
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  const pre = typeof prerelease === 'string' && prerelease.length > 0 ? prerelease.split('.') : [];
  return [Number(major), Number(minor), Number(patch), pre];
}

/** Returns < 0 if a < b, > 0 if a > b, 0 if equal. */
function compareSemver(a: SemverTuple, b: SemverTuple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  // Same MAJOR.MINOR.PATCH — stable releases beat prereleases.
  if (a[3].length === 0 && b[3].length > 0) return 1;
  if (a[3].length > 0 && b[3].length === 0) return -1;
  if (a[3].length === 0 && b[3].length === 0) return 0;
  // Both prereleases — compare identifiers per semver §11.
  const len = Math.min(a[3].length, b[3].length);
  for (let i = 0; i < len; i += 1) {
    const ai = a[3][i] as string;
    const bi = b[3][i] as string;
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) - Number(bi);
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  // All shared identifiers equal — the longer prerelease list
  // wins (semver §11: more identifiers means higher precedence
  // when leading identifiers match).
  return a[3].length - b[3].length;
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
