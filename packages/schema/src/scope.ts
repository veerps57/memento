import { z } from 'zod';
import { AbsolutePathSchema, RepoRemoteSchema, SessionIdSchema } from './primitives.js';

/**
 * `Scope` is the addressing dimension that determines **where** a
 * memory lives and **when** it should layer into a read.
 *
 * The five variants mirror the granularity at which AI coding
 * assistants reason about context:
 *
 * - `global`    — applies everywhere; small, hand-curated set of
 *                  preferences that survive across all workspaces.
 * - `workspace` — pinned to a specific filesystem path (typically
 *                  the user's project root). Used when there is no
 *                  git remote or when a project is intentionally
 *                  off-VCS.
 * - `repo`      — pinned to a canonical git remote. The default
 *                  write scope when a remote is detected: shared
 *                  across worktrees and clones of the same repo.
 * - `branch`    — pinned to a remote/branch pair. Useful for
 *                  branch-local context (in-flight refactor,
 *                  feature-flag plan).
 * - `session`   — pinned to a single MCP session. Cleared when the
 *                  session ends. Used for ephemeral working memory.
 *
 * Layered effective reads compose these tiers in order
 * (`session` ⊕ `branch` ⊕ `repo` ⊕ `workspace` ⊕ `global`); the
 * resolver lives in `@psraghuveer/memento-core`. The schema captures only the
 * shape and immutability invariants. Scope is **immutable** for the
 * lifetime of a memory: moving a memory to a different scope is
 * modelled as a supersession, not an in-place edit.
 */
export const ScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z
    .object({
      type: z.literal('workspace'),
      path: AbsolutePathSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('repo'),
      remote: RepoRemoteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('branch'),
      remote: RepoRemoteSchema,
      branch: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({
      type: z.literal('session'),
      id: SessionIdSchema,
    })
    .strict(),
]);

export type Scope = z.infer<typeof ScopeSchema>;

/**
 * The set of valid scope discriminators. Useful for config keys and
 * for exhaustiveness-checking switch statements that need a stable
 * iteration order (the order here matches the layering order from
 * most-specific to least-specific).
 */
export const SCOPE_TYPES = ['session', 'branch', 'repo', 'workspace', 'global'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * Exhaustiveness helper for `switch` over `Scope.type`. A misuse
 * (omitted variant) is a compile-time error because `value` would
 * have a non-`never` type.
 */
export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
