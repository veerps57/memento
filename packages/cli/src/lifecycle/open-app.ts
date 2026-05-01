// `openAppForSurface` — open a `MementoApp` for one of the
// surface lifecycle commands (`serve`, `context`, registry
// dispatch), wiring the optional local embedding provider when
// `retrieval.vector.enabled` is true.
//
// Why a helper:
//
//   The CLI used to call `deps.createApp({ dbPath })` directly
//   from each surface command. That left vector retrieval and
//   `embedding.rebuild` permanently unavailable through the CLI
//   binary, regardless of how the operator set the flag — a
//   gap that lived under "Active limitations" until this commit.
//
// Why two opens, not one:
//
//   `retrieval.vector.enabled` is read from the persisted
//   config layer (`config_events` rows projected by
//   `configRepository`). Reading it requires an open database
//   and applied migrations, which is exactly what `createApp`
//   does. We can't know whether to wire the embedder until the
//   app is up. So:
//
//     1. Open the app once with no embedder. Cheap (no model
//        load; the embedder package is lazy regardless).
//     2. Read the flag.
//     3. If false → return that app.
//     4. If true  → close it, resolve the embedder via the
//        injected seam, reopen with `embeddingProvider` set so
//        `embedding.rebuild` lands on the registry and the
//        search pipeline has a provider to call.
//
//   The reopen is intentional: `createMementoApp` builds the
//   registry up-front and freezes it, so we cannot retrofit
//   `embedding.rebuild` onto an already-open app. The cost is
//   one extra database open + migration on the
//   vector-enabled path; the benefit is that the CLI's surface
//   commands now Just Work when the flag is on.
//
// Why a structured CONFIG_ERROR when the peer is missing:
//
//   The doctor command already advertises `@psraghuveer/memento-embedder-local`
//   as a peer dependency. If the operator set the flag without
//   installing it, the next `memory.search` would fail with a
//   delayed CONFIG_ERROR from the search pipeline (no provider
//   wired). Surfacing the same error at app-open time, with a
//   crisp install hint, gives a much faster diagnosis loop.
//   `memento doctor` already runs the same resolve check.

import type { MementoApp } from '@psraghuveer/memento-core';
import { type Result, err, ok } from '@psraghuveer/memento-schema';

import type { LifecycleDeps } from './types.js';

export interface OpenAppOptions {
  readonly dbPath: string;
  /**
   * Memento package version to thread into `system.info`.
   * Optional: when omitted, `createMementoApp` falls back to
   * `'unknown'`. Surface callers pass `resolveVersion()` so
   * the assistant-callable probe matches `memento --version`.
   */
  readonly appVersion?: string;
}

/**
 * Open a fully-wired app for a surface lifecycle command. Reads
 * `retrieval.vector.enabled` from the persisted config layer
 * and conditionally re-opens with an embedding provider.
 *
 * Errors:
 *   - STORAGE_ERROR — `createApp` failed (bad path, broken
 *     migration, etc.).
 *   - CONFIG_ERROR  — flag is true but `resolveEmbedder` returned
 *     `undefined` (peer package not installed). The message
 *     points operators at the install command.
 */
export async function openAppForSurface(
  deps: LifecycleDeps,
  options: OpenAppOptions,
): Promise<Result<MementoApp>> {
  let probe: MementoApp;
  try {
    probe = await deps.createApp({
      dbPath: options.dbPath,
      ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
    });
  } catch (cause) {
    const hint = hintForOpenFailure(cause, options.dbPath);
    return err({
      code: 'STORAGE_ERROR',
      message: `failed to open database at '${options.dbPath}': ${describe(cause)}`,
      ...(hint !== undefined ? { hint } : {}),
    });
  }

  const wantVector = probe.configStore.get('retrieval.vector.enabled') === true;
  if (!wantVector) {
    return ok(probe);
  }

  // Vector path: close the probe app, resolve the embedder,
  // reopen with the provider so `embedding.rebuild` is on the
  // registry and `memory.search` has something to call.
  probe.close();

  const resolver = deps.resolveEmbedder;
  if (resolver === undefined) {
    return err({
      code: 'CONFIG_ERROR',
      message:
        'retrieval.vector.enabled is true but no embedder resolver was supplied to the CLI. Supply resolveEmbedder when invoking lifecycle commands programmatically, or disable vector search with `memento config set retrieval.vector.enabled false`.',
    });
  }

  let embeddingProvider: Awaited<ReturnType<NonNullable<LifecycleDeps['resolveEmbedder']>>>;
  try {
    embeddingProvider = await resolver();
  } catch (cause) {
    return err({
      code: 'CONFIG_ERROR',
      message: `retrieval.vector.enabled is true but the local embedder package failed to load: ${describe(cause)}. Try reinstalling @psraghuveer/memento, or disable vector search with \`memento config set retrieval.vector.enabled false\`.`,
    });
  }

  if (embeddingProvider === undefined) {
    return err({
      code: 'CONFIG_ERROR',
      message:
        'retrieval.vector.enabled is true but @psraghuveer/memento-embedder-local could not be resolved. Try reinstalling @psraghuveer/memento, or disable vector search with `memento config set retrieval.vector.enabled false`.',
    });
  }

  try {
    const app = await deps.createApp({
      dbPath: options.dbPath,
      embeddingProvider,
      ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
    });
    return ok(app);
  } catch (cause) {
    const hint = hintForOpenFailure(cause, options.dbPath);
    return err({
      code: 'STORAGE_ERROR',
      message: `failed to open database at '${options.dbPath}': ${describe(cause)}`,
      ...(hint !== undefined ? { hint } : {}),
    });
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Translate the most common `createApp` failure modes into a
 * one-sentence remediation. Returns `undefined` when no hint
 * applies; the caller omits the field rather than emitting an
 * unhelpful generic line.
 */
function hintForOpenFailure(cause: unknown, dbPath: string): string | undefined {
  const message = describe(cause);
  if (
    /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node/i.test(message)
  ) {
    return 'Run: npm rebuild better-sqlite3 --build-from-source (or reinstall after switching Node versions).';
  }
  if (/ENOENT/i.test(message) && dbPath !== ':memory:') {
    return `Create the parent directory first (e.g. mkdir -p "$(dirname ${dbPath})"), then retry.`;
  }
  if (/EACCES|permission denied/i.test(message)) {
    return 'The current user lacks permission to read or write the database path. Run \u0060memento doctor\u0060 for details.';
  }
  if (/SQLITE_NOTADB|file is not a database/i.test(message)) {
    return 'The path exists but is not a SQLite database. Move it aside or point --db at a different file.';
  }
  return undefined;
}
