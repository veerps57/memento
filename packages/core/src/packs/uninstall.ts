// Pack uninstall — filter helper.
//
// Uninstall does not own a separate write path. It builds the
// {@link MemoryListFilter} that `memory.forget_many` consumes:
// every active memory carrying the canonical `pack:<id>:<version>`
// tag (or the prefix `pack:<id>:` for `--all-versions`) in the
// caller's scope. The forget step itself runs through the
// existing bulk-destructive command surface (ADR-0014), which
// inherits dry-run-default and the `confirm: z.literal(true)`
// gate.
//
// Two filter shapes are supported:
//
//   - Specific version: filter by tag `pack:<id>:<version>`.
//     `MemoryListFilter.tags` is AND-matched, so a single tag
//     filters precisely to one pack/version combination.
//
//   - All versions: there is no native prefix-tag filter on
//     `MemoryListFilter` (tags are exact-match), so the helper
//     returns `null` for the tag and the caller is responsible
//     for filtering candidates by `parsePackTag`. The CLI / MCP
//     surface handles this branch by listing all memories with
//     the `pack:<id>:` prefix, then forwarding the resulting ids
//     to `memory.forget_many --ids ...` (ADR-0014's filter
//     dimension extension).

import {
  type PackId,
  type PackVersion,
  formatPackTag,
  packTagPrefix,
} from '@psraghuveer/memento-schema';

import type { MemoryListFilter } from '../repository/index.js';

/**
 * Plan for a single-version pack uninstall. Returns the list
 * filter that will match every memory installed by
 * `pack:<id>:<version>` in the caller's scope.
 *
 * The caller adds `scope` and `status: 'active'` (the standard
 * uninstall target). Existing forgotten or archived memories
 * from a prior uninstall are not re-forgotten.
 */
export function buildSingleVersionUninstallFilter(
  id: PackId,
  version: PackVersion,
): { readonly tags: readonly [string]; readonly status: 'active' } {
  const tag = formatPackTag(id, version);
  return { tags: [tag], status: 'active' } as const;
}

/**
 * Helper for `--all-versions` uninstall. Returns the tag prefix
 * that callers match against (e.g. via a substring scan of each
 * memory's tags). The result is `pack:<id>:`; every pack-installed
 * memory's `pack:<id>:<version>` tag begins with it.
 *
 * `MemoryListFilter.tags` is exact-match, so the caller cannot
 * pass this prefix to `repo.list({ tags: [...] })`. Instead, the
 * caller lists by scope alone, filters in-process by checking
 * each memory's `tags` for any entry that starts with this
 * prefix, and forwards the resulting ids to a future
 * `memory.forget_many` filter dimension that accepts an explicit
 * id set.
 */
export function buildAllVersionsUninstallTagPrefix(id: PackId): string {
  return packTagPrefix(id);
}

/**
 * Predicate companion to {@link buildAllVersionsUninstallTagPrefix}:
 * returns true if any tag in the supplied set begins with the
 * pack's all-versions prefix. Used to filter `Memory[]` results
 * client-side when a tag-prefix filter is needed.
 */
export function memoryHasAnyVersionOfPack(id: PackId, tags: readonly string[]): boolean {
  const prefix = packTagPrefix(id);
  return tags.some((t) => t.startsWith(prefix));
}

/**
 * Used by the command layer to assemble a `MemoryListFilter` for
 * the version-specific uninstall path. Kept separate from the
 * single-version helper above so the structural-typing on
 * `tags: readonly [string]` is preserved at the call site for
 * documentation purposes.
 */
export function uninstallListFilter(id: PackId, version: PackVersion): MemoryListFilter {
  return buildSingleVersionUninstallFilter(id, version);
}
