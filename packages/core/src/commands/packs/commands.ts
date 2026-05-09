// `pack.*` command set — install, preview, uninstall, list.
//
// Each command is a thin composition of:
//
//   1. Resolver — fetch raw YAML from bundled / file / URL.
//   2. Parser   — `parsePackManifest` from the engine.
//   3. Engine   — `translateManifestToWriteInputs`,
//                 `checkInstallState`, etc.
//   4. Repo     — `writeMany`, `forgetBatch`, `list`,
//                 `listClientTokensForFilter`.
//
// Per ADR-0020 the registry commands are the canonical surface
// for assistants and the dashboard alike. The CLI lifecycle
// wraps these for file-IO and pretty-printing only.

import {
  type MementoError,
  type MemoryId,
  type PackId,
  type PackVersion,
  type Result,
  type Scope,
  err,
  formatPackTag,
  ok,
  packTagPrefix,
  parsePackTag,
} from '@psraghuveer/memento-schema';

import type { ConfigStore } from '../../config/index.js';
import {
  type PackInstallTranslation,
  type PackSource,
  type PackSourceResolver,
  checkInstallState,
  parsePackManifest,
  translateManifestToWriteInputs,
} from '../../packs/index.js';
import type { MemoryRepository } from '../../repository/memory-repository.js';
import { repoErrorToMementoError } from '../errors.js';
import type { AnyCommand, Command } from '../types.js';

import {
  type PackInstallInput,
  PackInstallInputSchema,
  type PackInstallOutput,
  PackInstallOutputSchema,
  type PackListInput,
  PackListInputSchema,
  type PackListOutput,
  PackListOutputSchema,
  type PackPreviewInput,
  PackPreviewInputSchema,
  type PackPreviewOutput,
  PackPreviewOutputSchema,
  type PackSourceInput,
  type PackUninstallInput,
  PackUninstallInputSchema,
  type PackUninstallOutput,
  PackUninstallOutputSchema,
} from './inputs.js';

const SURFACES = ['mcp', 'cli', 'dashboard'] as const;

export interface PackCommandDeps {
  readonly memoryRepository: MemoryRepository;
  readonly resolver: PackSourceResolver;
  readonly configStore?: ConfigStore;
}

export function createPackCommands(deps: PackCommandDeps): readonly AnyCommand[] {
  const installCommand: Command<typeof PackInstallInputSchema, typeof PackInstallOutputSchema> = {
    name: 'pack.install',
    sideEffect: 'write',
    surfaces: SURFACES,
    inputSchema: PackInstallInputSchema,
    outputSchema: PackInstallOutputSchema,
    metadata: {
      description:
        'Install a memento pack — a curated YAML bundle of memories — from the bundled registry, a local file, or an HTTPS URL. Stamps `pack:<id>:<version>` provenance on every memory; idempotent on unchanged content; refuses with PACK_VERSION_REUSED on content drift without a version bump (ADR-0020).',
      mcpName: 'install_pack',
    },
    handler: async (input, ctx) => {
      const prepared = await prepareForInstallOrPreview(input.source, input.scope, deps);
      if (!prepared.ok) return prepared;
      const { translation, warnings } = prepared.value;

      const enforce = enforceMaxMemories(translation, deps.configStore);
      if (!enforce.ok) return enforce;

      const existingTokens = await listExistingTokens(translation, deps);
      if (!existingTokens.ok) return existingTokens;

      const state = checkInstallState(translation.expectedClientTokens, existingTokens.value);

      const previewItems = projectItemsForPreview(translation);
      const baseSnapshot = {
        packId: translation.manifest.id,
        version: translation.manifest.version,
        title: translation.manifest.title,
        ...(translation.manifest.description !== undefined
          ? { description: translation.manifest.description }
          : {}),
        scope: translation.scope,
        itemCount: translation.items.length,
        items: previewItems,
        warnings: [...warnings],
      };

      if (state.state === 'drift') {
        return err<MementoError>({
          code: 'INVALID_INPUT',
          message: `pack.install: ${state.reason}. Bump the manifest version (${translation.manifest.version} → next) before re-installing.`,
          details: {
            packId: translation.manifest.id,
            version: translation.manifest.version,
            errorKind: 'PACK_VERSION_REUSED',
          },
        });
      }

      if (input.dryRun) {
        return ok<PackInstallOutput>({
          ...baseSnapshot,
          state: state.state,
          dryRun: true,
          written: [],
          alreadyInstalled: state.state === 'idempotent',
        });
      }

      if (state.state === 'idempotent') {
        return ok<PackInstallOutput>({
          ...baseSnapshot,
          state: 'idempotent',
          dryRun: false,
          written: [],
          alreadyInstalled: true,
        });
      }

      // Fresh install — translate-then-writeMany.
      const defaultConfidence = deps.configStore?.get('write.defaultConfidence') ?? 1;
      const finalTranslation = translateManifestToWriteInputs(translation.manifest, {
        scopeOverride: input.scope ?? translation.scope,
        defaultConfidence,
      });
      try {
        const results = await deps.memoryRepository.writeMany(finalTranslation.items, {
          actor: ctx.actor,
        });
        const written = results.filter((r) => !r.idempotent).map((r) => r.memory.id);
        return ok<PackInstallOutput>({
          ...baseSnapshot,
          state: 'fresh',
          dryRun: false,
          written,
          alreadyInstalled: false,
        });
      } catch (e) {
        return err<MementoError>(repoErrorToMementoError(e, 'pack.install'));
      }
    },
  };

  const previewCommand: Command<typeof PackPreviewInputSchema, typeof PackPreviewOutputSchema> = {
    name: 'pack.preview',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: PackPreviewInputSchema,
    outputSchema: PackPreviewOutputSchema,
    metadata: {
      description:
        'Preview what `pack.install` would write. Resolves the manifest, classifies the install state (fresh / idempotent / drift), and returns the items without persisting. Read-only.',
      mcpName: 'preview_pack',
    },
    handler: async (input) => {
      const prepared = await prepareForInstallOrPreview(input.source, input.scope, deps);
      if (!prepared.ok) return prepared;
      const { translation, warnings } = prepared.value;

      const enforce = enforceMaxMemories(translation, deps.configStore);
      if (!enforce.ok) return enforce;

      const existingTokens = await listExistingTokens(translation, deps);
      if (!existingTokens.ok) return existingTokens;

      const state = checkInstallState(translation.expectedClientTokens, existingTokens.value);

      return ok<PackPreviewOutput>({
        packId: translation.manifest.id,
        version: translation.manifest.version,
        title: translation.manifest.title,
        ...(translation.manifest.description !== undefined
          ? { description: translation.manifest.description }
          : {}),
        scope: translation.scope,
        itemCount: translation.items.length,
        items: projectItemsForPreview(translation),
        warnings: [...warnings],
        state: state.state,
        ...(state.state === 'drift' ? { driftReason: state.reason } : {}),
      });
    },
  };

  const uninstallCommand: Command<
    typeof PackUninstallInputSchema,
    typeof PackUninstallOutputSchema
  > = {
    name: 'pack.uninstall',
    sideEffect: 'destructive',
    surfaces: SURFACES,
    inputSchema: PackUninstallInputSchema,
    outputSchema: PackUninstallOutputSchema,
    metadata: {
      description:
        'Forget every active memory installed by a pack — single version (default) or `allVersions: true`. Composes with the bulk-destructive contract from ADR-0014: dry-run defaults true, `confirm: true` is required, the `safety.bulkDestructiveLimit` cap applies on apply.',
      mcpName: 'uninstall_pack',
    },
    handler: async (input, ctx) => {
      const ids = await collectUninstallIds(input, deps);
      if (!ids.ok) return ids;
      const matchedIds = ids.value;

      if (input.dryRun) {
        return ok<PackUninstallOutput>({
          dryRun: true,
          matched: matchedIds.length,
          applied: 0,
          ids: matchedIds,
          packId: input.id,
          version: input.allVersions ? null : (input.version as PackVersion),
        });
      }

      const limit = deps.configStore?.get('safety.bulkDestructiveLimit') ?? 1000;
      if (matchedIds.length > limit) {
        return err<MementoError>({
          code: 'INVALID_INPUT',
          message: `pack.uninstall: ${matchedIds.length} matched exceeds safety.bulkDestructiveLimit (${limit}); raise the cap or narrow the scope.`,
          details: { limit, matched: matchedIds.length },
        });
      }

      try {
        const result = await deps.memoryRepository.forgetBatch(matchedIds, null, {
          actor: ctx.actor,
        });
        return ok<PackUninstallOutput>({
          dryRun: false,
          matched: matchedIds.length,
          applied: result.applied,
          ids: matchedIds,
          packId: input.id,
          version: input.allVersions ? null : (input.version as PackVersion),
        });
      } catch (e) {
        return err<MementoError>(repoErrorToMementoError(e, 'pack.uninstall'));
      }
    },
  };

  const listCommand: Command<typeof PackListInputSchema, typeof PackListOutputSchema> = {
    name: 'pack.list',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: PackListInputSchema,
    outputSchema: PackListOutputSchema,
    metadata: {
      description:
        "List installed packs — every active memory's `pack:<id>:<version>` tag is grouped, returning the pack id, version, scope, and memory count.",
      mcpName: 'list_packs',
    },
    handler: async (input) => {
      const memories = await deps.memoryRepository.list({
        status: 'active',
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      });
      const groups = new Map<
        string,
        { id: PackId; version: PackVersion; scope: Scope; count: number }
      >();
      for (const memory of memories) {
        for (const tag of memory.tags) {
          const parsed = parsePackTag(tag);
          if (!parsed) continue;
          const key = `${parsed.id}:${parsed.version}:${JSON.stringify(memory.scope)}`;
          const existing = groups.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            groups.set(key, {
              id: parsed.id as PackId,
              version: parsed.version as PackVersion,
              scope: memory.scope,
              count: 1,
            });
          }
        }
      }
      return ok<PackListOutput>({ packs: [...groups.values()] });
    },
  };

  return [installCommand, previewCommand, uninstallCommand, listCommand] as const;
}

// — Internals —

interface InstallPrepared {
  readonly translation: PackInstallTranslation;
  readonly warnings: readonly string[];
}

async function prepareForInstallOrPreview(
  source: PackSourceInput,
  scopeOverride: Scope | undefined,
  deps: PackCommandDeps,
): Promise<Result<InstallPrepared>> {
  // PackSourceInput and PackSource carry the same wire shape;
  // the cast lets us reuse the engine's typed source without
  // duplicating the discriminated union.
  const resolved = await deps.resolver.resolve(source as unknown as PackSource);
  if (!resolved.ok) {
    const code: MementoError['code'] =
      resolved.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : resolved.code === 'REMOTE_DISABLED'
          ? 'CONFIG_ERROR'
          : 'INVALID_INPUT';
    return err<MementoError>({
      code,
      message: `pack: failed to resolve source — ${resolved.error}`,
      details: { resolveError: resolved.code },
    });
  }
  const parseResult = parsePackManifest(resolved.raw);
  if (!parseResult.ok) {
    const loc =
      parseResult.line !== undefined
        ? ` (line ${parseResult.line}${parseResult.column !== undefined ? `, col ${parseResult.column}` : ''})`
        : '';
    return err<MementoError>({
      code: 'INVALID_INPUT',
      message: `pack: manifest parse failed${loc}: ${parseResult.error}`,
      details: { sourceLabel: resolved.sourceLabel },
    });
  }
  const defaultConfidence = deps.configStore?.get('write.defaultConfidence') ?? 1;
  const translation = translateManifestToWriteInputs(parseResult.manifest, {
    ...(scopeOverride !== undefined ? { scopeOverride } : {}),
    defaultConfidence,
  });
  return ok({ translation, warnings: parseResult.warnings });
}

function enforceMaxMemories(
  translation: PackInstallTranslation,
  configStore: ConfigStore | undefined,
): Result<undefined> {
  const max = configStore?.get('packs.maxMemoriesPerPack') ?? 200;
  if (translation.items.length > max) {
    return err<MementoError>({
      code: 'INVALID_INPUT',
      message: `pack: manifest carries ${translation.items.length} memories; exceeds packs.maxMemoriesPerPack (${max}). Raise the cap or split the pack.`,
      details: { limit: max, received: translation.items.length },
    });
  }
  return ok(undefined);
}

async function listExistingTokens(
  translation: PackInstallTranslation,
  deps: PackCommandDeps,
): Promise<Result<readonly string[]>> {
  const tag = formatPackTag(translation.manifest.id, translation.manifest.version);
  try {
    const tokens = await deps.memoryRepository.listClientTokensForFilter({
      status: 'active',
      tags: [tag],
      scope: translation.scope,
    });
    return ok(tokens);
  } catch (e) {
    return err<MementoError>(repoErrorToMementoError(e, 'pack.install'));
  }
}

function projectItemsForPreview(translation: PackInstallTranslation): PackPreviewOutput['items'] {
  return translation.items.map((item) => ({
    kind: item.kind.type,
    content: item.content,
    summary: item.summary,
    tags: [...item.tags],
    pinned: item.pinned,
    ...(item.kind.type === 'decision' ? { rationale: item.kind.rationale } : {}),
    ...(item.kind.type === 'todo' ? { due: item.kind.due } : {}),
    ...(item.kind.type === 'snippet' ? { language: item.kind.language } : {}),
  }));
}

async function collectUninstallIds(
  input: PackUninstallInput,
  deps: PackCommandDeps,
): Promise<Result<MemoryId[]>> {
  const baseFilter = {
    status: 'active' as const,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  };
  if (input.allVersions) {
    // Tag exact-match doesn't support a prefix filter. List by
    // scope + status, then filter in-process by the pack:<id>:
    // prefix.
    try {
      const memories = await deps.memoryRepository.list(baseFilter);
      const prefix = packTagPrefix(input.id);
      const ids = memories.filter((m) => m.tags.some((t) => t.startsWith(prefix))).map((m) => m.id);
      return ok(ids);
    } catch (e) {
      return err<MementoError>(repoErrorToMementoError(e, 'pack.uninstall'));
    }
  }
  // Single-version path uses exact-tag filter via listIdsForBulk.
  if (!input.version) {
    return err<MementoError>({
      code: 'INVALID_INPUT',
      message: 'pack.uninstall: pass either `version` or `allVersions: true`',
    });
  }
  const tag = formatPackTag(input.id, input.version);
  try {
    const ids = await deps.memoryRepository.listIdsForBulk({
      ...baseFilter,
      tags: [tag],
    });
    return ok([...ids]);
  } catch (e) {
    return err<MementoError>(repoErrorToMementoError(e, 'pack.uninstall'));
  }
}

// Re-export for tests + adapters that need a single import.
export type { PackInstallInput, PackInstallOutput, PackListInput, PackListOutput };
export type { PackPreviewInput, PackPreviewOutput, PackUninstallInput, PackUninstallOutput };
