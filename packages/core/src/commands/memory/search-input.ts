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
      // A whitespace-only query passes `min(1)` but the FTS
      // sanitiser drops every token, so the search returns
      // vector-only results without any signal that the FTS arm
      // contributed nothing. Reject after-trim instead.
      .refine((s) => s.trim().length > 0, {
        message: 'must contain at least one non-whitespace character',
      })
      .describe(
        'Free-text search query. Searches memory content and summaries. Must contain at least one non-whitespace character — empty / whitespace-only queries are rejected. Treated as a term bag — FTS5 syntax (AND / OR / NOT / NEAR / phrase / prefix) is NOT parsed; tokens are stripped of operators and ranked via BM25 + vector similarity.',
      ),
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
    createdAtAfter: TimestampSchema.optional().describe(
      'Inclusive lower bound on `createdAt`. ISO-8601 UTC. Filters out memories created before this instant. Pair with `createdAtBefore` for a half-open window.',
    ),
    createdAtBefore: TimestampSchema.optional().describe(
      'Exclusive upper bound on `createdAt`. ISO-8601 UTC. Filters out memories created at or after this instant.',
    ),
    confirmedAfter: TimestampSchema.optional().describe(
      'Inclusive lower bound on `lastConfirmedAt`. ISO-8601 UTC. Useful for "what changed recently?" forensics.',
    ),
    confirmedBefore: TimestampSchema.optional().describe(
      'Exclusive upper bound on `lastConfirmedAt`. ISO-8601 UTC.',
    ),
    includeEmbedding: z
      .boolean()
      .optional()
      .describe(
        'Whether to include the full embedding vector in results. Defaults to false. Embedding vectors can be large (hundreds of floats); omit or set to false for compact output.',
      ),
    projection: z
      .enum(['full', 'summary'])
      .optional()
      .describe(
        "Response shape. `summary` (default) returns the memory view + score — the lean shape for LLM agents and most CLI callers that don't need ranking diagnostics. `full` adds the per-arm `breakdown` (FTS/vector/confidence/recency/scope/pinned scores) and the `conflicts` array — the explainability shape for dashboards, debug tooling, and operators tuning ranker weights. `summary` is typically ~30-40% smaller than `full` on a top-10 page.",
      ),
  })
  .strict();

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;
