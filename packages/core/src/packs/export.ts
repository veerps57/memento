// Pack export — `Memory[] + metadata → PackManifest`.
//
// The dual of {@link translateManifestToWriteInputs}: takes
// memories the user has already written and produces a fresh
// manifest object suitable for stringifying as YAML. Pure — no
// filesystem or repo dependency, so the function is trivially
// unit-testable.
//
// Two integrity rules are non-negotiable here, mirroring the
// install side:
//
// 1. Reserved-prefix tags (`pack:*`) are stripped from every
//    memory's tag list before constructing the `PackMemoryItem`.
//    Otherwise the resulting manifest would fail `PackManifestSchema`
//    (its tags use `NonReservedTagSchema`), and even if it
//    passed validation, an installer would re-stamp on top of
//    those tags and the user would end up with a meta-pack of
//    pack-installed content.
// 2. The manifest's `defaults.scope` is the single scope every
//    memory in the export shares. If memories span more than one
//    scope, the export refuses with a clear error — `PackMemoryItem`
//    has no per-item scope, so the only honest representation is
//    a single-scope pack. Operators who want a multi-scope bundle
//    must export each scope as its own pack.

import {
  type Memory,
  PACK_FORMAT_VERSION,
  type PackId,
  type PackManifest,
  PackManifestSchema,
  type PackMemoryItem,
  type PackVersion,
  type Scope,
  isReservedTag,
} from '@psraghuveer/memento-schema';
import { stringify as yamlStringify } from 'yaml';

export interface PackExportMetadata {
  readonly packId: PackId;
  readonly version: PackVersion;
  readonly title: string;
  readonly description?: string;
  readonly author?: string;
  readonly license?: string;
  readonly homepage?: string;
  /** Pack-discovery tags; not memory tags. Optional. */
  readonly tags?: readonly string[];
}

export interface PackExportResult {
  readonly manifest: PackManifest;
  readonly yaml: string;
  /** Number of memories included after reserved-tag stripping. */
  readonly exported: number;
  /** Diagnostic notes (e.g. "stripped `pack:*` tags from N memories"). */
  readonly warnings: readonly string[];
}

export type PackExportError =
  | { readonly kind: 'EMPTY' }
  | {
      readonly kind: 'MULTI_SCOPE';
      readonly scopeCount: number;
      readonly scopes: readonly Scope[];
    }
  | { readonly kind: 'INVALID_MANIFEST'; readonly issues: readonly string[] };

export type PackExportOutcome =
  | { readonly ok: true; readonly value: PackExportResult }
  | { readonly ok: false; readonly error: PackExportError };

/**
 * Builds a manifest from the supplied memories and metadata. Pure;
 * does not consult the database. Returns a discriminated outcome
 * rather than throwing — the caller (a registry command, the CLI)
 * surfaces the failure modes as `Result.err`.
 */
export function buildManifestFromMemories(
  memories: readonly Memory[],
  metadata: PackExportMetadata,
): PackExportOutcome {
  if (memories.length === 0) {
    return { ok: false, error: { kind: 'EMPTY' } };
  }

  const scopes = uniqueScopes(memories);
  if (scopes.length !== 1) {
    return {
      ok: false,
      error: { kind: 'MULTI_SCOPE', scopeCount: scopes.length, scopes },
    };
  }
  const sharedScope = scopes[0] as Scope;

  const warnings: string[] = [];
  let strippedCount = 0;
  const items: PackMemoryItem[] = [];
  for (const memory of memories) {
    const filteredTags = memory.tags.filter((t) => !isReservedTag(t));
    if (filteredTags.length !== memory.tags.length) {
      strippedCount += memory.tags.length - filteredTags.length;
    }
    items.push(toPackMemoryItem(memory, filteredTags));
  }
  if (strippedCount > 0) {
    warnings.push(
      `stripped ${strippedCount} reserved-prefix tag(s) from ${memories.length} memory record(s)`,
    );
  }

  const manifestCandidate = {
    format: PACK_FORMAT_VERSION,
    id: metadata.packId,
    version: metadata.version,
    title: metadata.title,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.author !== undefined ? { author: metadata.author } : {}),
    ...(metadata.license !== undefined ? { license: metadata.license } : {}),
    ...(metadata.homepage !== undefined ? { homepage: metadata.homepage } : {}),
    ...(metadata.tags !== undefined ? { tags: [...metadata.tags] } : {}),
    defaults: { scope: sharedScope },
    memories: items,
  };

  const validation = PackManifestSchema.safeParse(manifestCandidate);
  if (!validation.success) {
    return {
      ok: false,
      error: {
        kind: 'INVALID_MANIFEST',
        issues: validation.error.issues.map((issue) => {
          const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
          return `${path}${issue.message}`;
        }),
      },
    };
  }

  const yaml = yamlStringify(validation.data, {
    blockQuote: 'literal',
    lineWidth: 0,
  });

  return {
    ok: true,
    value: {
      manifest: validation.data,
      yaml,
      exported: items.length,
      warnings,
    },
  };
}

function toPackMemoryItem(memory: Memory, tags: readonly string[]): PackMemoryItem {
  const base = {
    content: memory.content,
    ...(memory.summary !== null ? { summary: memory.summary } : {}),
    ...(tags.length > 0 ? { tags: [...tags] } : {}),
    ...(memory.pinned ? { pinned: true } : {}),
    ...(memory.sensitive ? { sensitive: true } : {}),
  } as const;
  switch (memory.kind.type) {
    case 'fact':
      return { kind: 'fact', ...base } as PackMemoryItem;
    case 'preference':
      return { kind: 'preference', ...base } as PackMemoryItem;
    case 'decision':
      return {
        kind: 'decision',
        ...(memory.kind.rationale !== null ? { rationale: memory.kind.rationale } : {}),
        ...base,
      } as PackMemoryItem;
    case 'todo':
      return {
        kind: 'todo',
        ...(memory.kind.due !== null ? { due: memory.kind.due } : {}),
        ...base,
      } as PackMemoryItem;
    case 'snippet':
      return {
        kind: 'snippet',
        ...(memory.kind.language !== null ? { language: memory.kind.language } : {}),
        ...base,
      } as PackMemoryItem;
  }
}

function uniqueScopes(memories: readonly Memory[]): readonly Scope[] {
  const seen = new Map<string, Scope>();
  for (const memory of memories) {
    const key = JSON.stringify(memory.scope);
    if (!seen.has(key)) seen.set(key, memory.scope);
  }
  return [...seen.values()];
}
