// Pack install translator + version-check.
//
// `translateManifestToWriteInputs` is a pure function: given a
// parsed `PackManifest` and an `InstallOptions` (scope override),
// it returns an array of `MemoryWriteInput[]` ready to feed
// through the standard `memory.write_many` path. Every item
// carries the canonical pack provenance tag `pack:<id>:<version>`
// and a deterministic `clientToken` derived from
// `(packId, version, index, content-canonicalisation)`.
//
// `checkInstallState` is a pure function: given the expected
// clientTokens for a fresh install and the existing memories
// already tagged `pack:<id>:<version>` in the install scope, it
// classifies the install as `fresh`, `idempotent`, or `drift`.
// The command layer composes the two: translate first, query the
// repository, classify, then either short-circuit (idempotent),
// reject (drift → `PACK_VERSION_REUSED`), or commit (fresh).
//
// Integrity rules are honoured by composition: the standard
// write path scrubs / stamps `OwnerRef` local-self / records the
// `created` event. The pack engine is *just* a translator — it
// is not responsible for the write itself, the audit chain, or
// the scrubber. That separation keeps `install.ts` testable
// without a database.

import { createHash } from 'node:crypto';

import {
  type MemoryKind,
  type PackId,
  type PackManifest,
  type PackMemoryItem,
  type PackVersion,
  type Scope,
  formatPackTag,
} from '@psraghuveer/memento-schema';

import type { MemoryWriteInput } from '../repository/index.js';

export interface PackInstallOptions {
  /**
   * If set, overrides the manifest's `defaults.scope`. The
   * canonical default when neither is set is `{ type: 'global' }`.
   */
  readonly scopeOverride?: Scope;
  /**
   * Default `storedConfidence` to stamp on every item. Pack
   * memories inherit the same default as a `memory.write` (`1.0`
   * unless `write.defaultConfidence` is overridden) — they are
   * authored, not extracted, so they should not silently decay
   * faster than hand-written memories. Threading the default
   * through here keeps the engine config-free; the command layer
   * resolves the value from `ConfigStore` and passes it in.
   */
  readonly defaultConfidence?: number;
}

export interface PackInstallTranslation {
  readonly manifest: PackManifest;
  /** Scope every item lands in. `scopeOverride` if supplied, otherwise `manifest.defaults.scope`, otherwise global. */
  readonly scope: Scope;
  /** Items shaped for `memory.write_many`, in manifest order. */
  readonly items: readonly MemoryWriteInput[];
  /** Per-item deterministic clientToken in manifest order. */
  readonly expectedClientTokens: readonly string[];
}

export type PackInstallStateName = 'fresh' | 'idempotent' | 'drift';

export type PackInstallState =
  | { readonly state: 'fresh' }
  | { readonly state: 'idempotent' }
  | { readonly state: 'drift'; readonly reason: string };

/**
 * Translates a parsed pack manifest into the
 * {@link MemoryWriteInput} array the command handler will
 * forward to `memory.write_many`. Pure — no IO, no database.
 *
 * The translation merges manifest-level defaults into each
 * memory (scope, pinned, tags), appends the canonical pack
 * provenance tag, and computes a deterministic
 * content-aware clientToken so re-installs are idempotent on
 * unchanged content and visibly drift on changed content.
 */
export function translateManifestToWriteInputs(
  manifest: PackManifest,
  options: PackInstallOptions = {},
): PackInstallTranslation {
  const packTag = formatPackTag(manifest.id, manifest.version);
  const defaultScope = options.scopeOverride ?? manifest.defaults?.scope ?? { type: 'global' };
  const defaultPinned = manifest.defaults?.pinned ?? false;
  const defaultTags = manifest.defaults?.tags ?? [];

  const items: MemoryWriteInput[] = [];
  const tokens: string[] = [];

  const storedConfidence = options.defaultConfidence ?? 1;

  manifest.memories.forEach((item, index) => {
    const tags = uniqueTags([...defaultTags, ...(item.tags ?? []), packTag]);
    const clientToken = derivePackClientToken(manifest.id, manifest.version, index, item);
    items.push({
      scope: defaultScope,
      owner: { type: 'local', id: 'self' },
      kind: kindFromManifestItem(item),
      tags,
      pinned: item.pinned ?? defaultPinned,
      content: item.content,
      summary: item.summary ?? null,
      storedConfidence,
      sensitive: item.sensitive ?? false,
      clientToken,
    });
    tokens.push(clientToken);
  });

  return {
    manifest,
    scope: defaultScope,
    items,
    expectedClientTokens: tokens,
  };
}

/**
 * Classifies a pack install attempt against the clientTokens
 * already present on memories tagged `pack:<id>:<version>` in
 * the install scope.
 *
 * - `fresh` — no existing tokens carry the tag → write
 *   everything.
 * - `idempotent` — existing tokens exactly match the expected
 *   set → no-op; the store is already in the target state.
 * - `drift` — existing tokens differ from expected → the
 *   manifest's content has been changed without bumping the
 *   version. Refuse with `PACK_VERSION_REUSED`. The pack author
 *   must mint a new version.
 *
 * The command layer is responsible for fetching the existing
 * tokens (via a repository helper); this function is pure and
 * IO-free, which keeps the engine testable without a database.
 */
export function checkInstallState(
  expectedClientTokens: readonly string[],
  existingTokens: readonly string[],
): PackInstallState {
  if (existingTokens.length === 0) return { state: 'fresh' };

  const existingTokenSet = new Set(existingTokens);
  const expectedTokenSet = new Set(expectedClientTokens);

  if (
    existingTokenSet.size === expectedTokenSet.size &&
    [...expectedTokenSet].every((t) => existingTokenSet.has(t))
  ) {
    return { state: 'idempotent' };
  }

  return {
    state: 'drift',
    reason: buildDriftReason(expectedClientTokens, existingTokenSet),
  };
}

/**
 * Deterministic clientToken for one pack memory. Includes the
 * pack id, version, manifest index, and a canonical hash of the
 * memory's user-supplied content fields so that:
 *
 * - Re-installing the same manifest produces identical tokens
 *   (idempotent — repo's `(scope, clientToken)` index returns
 *   the existing memory).
 * - Editing a memory's content while keeping the version
 *   produces a different token, which surfaces as `drift` in
 *   {@link checkInstallState}.
 *
 * Output: `pack-<16hex>` (≤ 21 chars), well under
 * `MemoryWriteInputSchema.clientToken`'s 128-char ceiling.
 */
export function derivePackClientToken(
  id: PackId,
  version: PackVersion,
  index: number,
  item: PackMemoryItem,
): string {
  const digest = canonicalMemoryDigest(item);
  const hash = createHash('sha256')
    .update(`${id}:${version}:${index}:${digest}`)
    .digest('hex')
    .slice(0, 16);
  return `pack-${hash}`;
}

/**
 * Stable, pipe-separated digest of a manifest memory item. The
 * fields are listed explicitly (rather than via `JSON.stringify`)
 * so that JS object-key order can never affect the result.
 *
 * Excludes pack-level cosmetic fields (title, description,
 * author, license, homepage, top-level tags) because they live
 * outside the manifest item; including them would make
 * cosmetic edits trip drift detection. Per ADR-0020 §Detect
 * content drift.
 */
function canonicalMemoryDigest(item: PackMemoryItem): string {
  const parts: string[] = [];
  parts.push(`kind=${item.kind}`);
  parts.push(`content=${item.content}`);
  parts.push(`summary=${item.summary ?? ''}`);
  parts.push(`tags=${(item.tags ?? []).slice().sort().join(',')}`);
  parts.push(`pinned=${item.pinned ?? false}`);
  parts.push(`sensitive=${item.sensitive ?? false}`);
  switch (item.kind) {
    case 'fact':
    case 'preference':
      break;
    case 'decision':
      parts.push(`rationale=${item.rationale ?? ''}`);
      break;
    case 'todo':
      parts.push(`due=${item.due ?? ''}`);
      break;
    case 'snippet':
      parts.push(`language=${item.language ?? ''}`);
      break;
  }
  return parts.join('|');
}

function kindFromManifestItem(item: PackMemoryItem): MemoryKind {
  switch (item.kind) {
    case 'fact':
      return { type: 'fact' };
    case 'preference':
      return { type: 'preference' };
    case 'decision':
      return { type: 'decision', rationale: item.rationale ?? null };
    case 'todo':
      return { type: 'todo', due: item.due ?? null };
    case 'snippet':
      return { type: 'snippet', language: item.language ?? null };
  }
}

function uniqueTags(tags: readonly string[]): string[] {
  return [...new Set(tags)];
}

function buildDriftReason(
  expectedTokens: readonly string[],
  existingTokens: ReadonlySet<string>,
): string {
  const expectedSet = new Set(expectedTokens);
  const missing = [...expectedSet].filter((t) => !existingTokens.has(t)).length;
  const extra = [...existingTokens].filter((t) => !expectedSet.has(t)).length;
  return `pack content has changed without a version bump (${expectedSet.size} expected, ${existingTokens.size} present, ${missing} new, ${extra} stale)`;
}
