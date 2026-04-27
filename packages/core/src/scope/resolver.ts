/**
 * Effective-read resolver.
 *
 * Implements the read-time scope layering described in
 * `docs/architecture/scope-semantics.md`:
 *
 *   "Layered effective reads compose these tiers in order
 *    (session ⊕ branch ⊕ repo ⊕ workspace ⊕ global)."
 *
 * This module is **pure**: it consumes an {@link ActiveScopes}
 * snapshot (already resolved by the IO-layer scope resolvers —
 * workspace path, git remote, session id) plus a {@link ScopeFilter}
 * directive and returns the ordered, deduped list of scopes the
 * read path should query.
 *
 * Keeping the layering pure lets the IO resolvers evolve
 * independently and lets tests pin the policy without spinning up
 * a git repo or a session.
 */

import { type Scope, assertNever } from '@psraghuveer/memento-schema';

/**
 * Snapshot of the resolved scopes for the current call. Each tier
 * is independently optional: if the cwd is not in a git repo,
 * `repo` and `branch` are `null`; if there is no live MCP session,
 * `session` is `null`. `global` and `workspace` are always
 * resolvable (workspace defaults to the cwd) so they are required.
 */
export interface ActiveScopes {
  readonly session: Extract<Scope, { type: 'session' }> | null;
  readonly branch: Extract<Scope, { type: 'branch' }> | null;
  readonly repo: Extract<Scope, { type: 'repo' }> | null;
  readonly workspace: Extract<Scope, { type: 'workspace' }>;
  readonly global: Extract<Scope, { type: 'global' }>;
}

/**
 * Read-time scope filter.
 *
 * - `'effective'`: layered set (session ⊕ branch ⊕ repo ⊕ workspace ⊕ global).
 *   This is the default for `memory.search` and `memory.list`.
 * - `'all'`: every scope visible to the resolver — same as `'effective'`
 *   today (the resolver only knows about the active scopes), but kept
 *   as a distinct directive so future cross-scope reads (e.g. across
 *   sibling branches) can opt in without breaking callers.
 * - `Scope[]`: an explicit list — the caller knows exactly what they
 *   want. Used by audit UIs and `memento export --scope=...`.
 */
export type ScopeFilter = 'all' | 'effective' | readonly Scope[];

/**
 * Order matters: most-specific first. The retrieval ranker uses
 * the index of a memory's scope in this list as the input to
 * `retrieval.scopeBoost`, so changing this order is a behaviour
 * change for ranking and must be coordinated with that config.
 */
const LAYER_ORDER = ['session', 'branch', 'repo', 'workspace', 'global'] as const;

/**
 * Layer the active scopes into the most-specific-first list used
 * by the read path. Tiers that are `null` (e.g. no git remote)
 * are skipped — there is no synthetic placeholder scope.
 */
export function effectiveScopes(active: ActiveScopes): Scope[] {
  const out: Scope[] = [];
  for (const tier of LAYER_ORDER) {
    const scope = active[tier];
    if (scope !== null) {
      out.push(scope);
    }
  }
  return out;
}

/**
 * Apply a {@link ScopeFilter} against an {@link ActiveScopes}
 * snapshot. The result is the ordered list of scopes the query
 * layer should filter by.
 *
 * Explicit `Scope[]` filters are returned in caller-supplied order
 * after deduping. Duplicates are silently collapsed rather than
 * raised because callers often build the list by concatenating
 * partials.
 */
export function resolveEffectiveScopes(filter: ScopeFilter, active: ActiveScopes): Scope[] {
  if (filter === 'effective' || filter === 'all') {
    return effectiveScopes(active);
  }
  // Explicit list: preserve order, dedupe by structural key.
  const seen = new Set<string>();
  const out: Scope[] = [];
  for (const scope of filter) {
    const key = scopeKey(scope);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(scope);
  }
  return out;
}

/**
 * Stable structural key for a scope value. Used for deduping in
 * {@link resolveEffectiveScopes} and for the boost-index lookup
 * by retrieval. Two scopes are equal iff their keys are equal.
 *
 * Keys deliberately encode the discriminator first so a sorted
 * list of keys groups by tier, which is convenient for debugging
 * audit dumps.
 */
export function scopeKey(scope: Scope): string {
  switch (scope.type) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace:${scope.path}`;
    case 'repo':
      return `repo:${scope.remote}`;
    case 'branch':
      return `branch:${scope.remote}@${scope.branch}`;
    case 'session':
      return `session:${scope.id}`;
    default:
      // Per AGENTS.md rule 7: exhaustive switches over discriminated
      // unions terminate in `assertNever` so that adding a new
      // `Scope` variant is a compile-time error here.
      return assertNever(scope);
  }
}
