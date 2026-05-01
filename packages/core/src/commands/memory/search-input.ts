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
    text: z
      .string()
      .min(1)
      .describe('Free-text search query. Searches memory content and summaries.'),
    scopes: z
      .array(ScopeSchema)
      .optional()
      .describe(
        'Optional scope filter. Each element uses the same shape as memory.write scope (e.g. {"type":"global"}). Omit to search all visible scopes.',
      ),
    includeStatuses: z
      .array(z.enum(MEMORY_STATUSES))
      .optional()
      .describe(
        'Which statuses to include. Defaults to ["active"]. Options: "active", "superseded", "forgotten", "archived".',
      ),
    kinds: z
      .array(z.enum(MEMORY_KIND_TYPES))
      .optional()
      .describe(
        'Filter by memory kind types. Options: "fact", "preference", "decision", "todo", "snippet". Omit for all.',
      ),
    tags: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Filter to memories containing ALL of these tags (AND logic). Tags are normalised to lowercase. Example: ["project:memento"].',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of results to return. Server clamps to configured max.'),
    cursor: MemoryIdSchema.optional().describe(
      'Pagination cursor — pass the nextCursor from a previous search response to get the next page.',
    ),
    now: TimestampSchema.optional().describe(
      'Override clock for decay calculation. ISO-8601 UTC. Omit to use wall-clock time.',
    ),
  })
  .strict();

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;
