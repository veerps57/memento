// Zod input schema for `memory.search`.
//
// Mirrors the `SearchQuery` shape from the retrieval engine but
// with wire-friendly conventions: scopes/kinds/statuses are
// plain arrays (not readonly), and `now` is optional —
// adapters typically let the engine stamp it.
//
// Keep this file separate from the data-plane `inputs.ts` set
// because the search command pulls its config layer through a
// different deps object (`SearchDeps`) and we want the import
// graph to reflect that boundary.

import {
  MEMORY_KIND_TYPES,
  MEMORY_STATUSES,
  MemoryIdSchema,
  ScopeSchema,
  TimestampSchema,
} from '@psraghuveer/memento-schema';
import { z } from 'zod';

export const MemorySearchInputSchema = z
  .object({
    /** Free-text query. The engine sanitises FTS5 sigils internally. */
    text: z.string().min(1),
    /**
     * Optional explicit scope filter. When omitted the search runs
     * against every scope visible to the actor — the host
     * (`@psraghuveer/memento-server`) decides whether to inject the active
     * layered scopes here. Keeping that policy out of the engine
     * means CLI runs (which know the cwd) and MCP runs (which know
     * the session) compose the same primitive consistently.
     */
    scopes: z.array(ScopeSchema).optional(),
    /**
     * Statuses to include. Defaults to `['active']` inside the
     * engine; surfaced here so admin tooling can audit
     * superseded / forgotten / archived memories explicitly.
     */
    includeStatuses: z.array(z.enum(MEMORY_STATUSES)).optional(),
    /** Optional kind filter. */
    kinds: z.array(z.enum(MEMORY_KIND_TYPES)).optional(),
    /**
     * Page size. The engine clamps against
     * `retrieval.search.maxLimit` so a malicious caller cannot
     * exhaust memory by asking for `Number.MAX_SAFE_INTEGER`.
     */
    limit: z.number().int().positive().optional(),
    /**
     * Pagination cursor. Pass the `nextCursor` from the previous
     * page to fetch the next slice. Stable across pages because
     * the ranker is a pure function of the query + memory state.
     */
    cursor: MemoryIdSchema.optional(),
    /**
     * Override clock. Useful for replay / test harnesses; in
     * production the engine uses `deps.clock` or wall-clock now.
     */
    now: TimestampSchema.optional(),
  })
  .strict();

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;
