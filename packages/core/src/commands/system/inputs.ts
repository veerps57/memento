// Wire-shape input schemas for the `system.*` command set.
//
// Both commands here are read-only introspection probes whose
// inputs are intentionally minimal: an MCP-capable assistant
// should be able to call them with no arguments. Optional
// filters are added only when they avoid forcing the caller to
// post-filter a large response.

import { MEMORY_STATUSES } from '@psraghuveer/memento-schema';
import { z } from 'zod';

/**
 * `system.info` takes no arguments. The schema is the empty
 * strict object so the adapter still rejects unknown keys
 * (defence in depth: a buggy client cannot smuggle filter-like
 * fields that we silently ignore).
 */
export const SystemInfoInputSchema = z.object({}).strict();

/**
 * `system.list_scopes` likewise takes no arguments in v1. We
 * deliberately skip a `min`/`max` filter — the universe of
 * scopes a single store has ever held is small (single-digit to
 * low-hundreds) and capping to `top N` would force the assistant
 * to guess a useful threshold. If real-world stores grow large
 * enough that the response becomes a problem, a `limit`
 * parameter is an additive change.
 */
export const SystemListScopesInputSchema = z.object({}).strict();

/**
 * `system.list_tags` accepts an optional status filter. When
 * omitted, only active memories are considered (the common case
 * for an agent deciding which tags to filter on). The result is
 * a flat array of `{ tag, count }` objects sorted by count
 * descending — an agent can inspect the top-N directly without
 * paging or post-processing.
 */
export const SystemListTagsInputSchema = z
  .object({
    status: z
      .enum(MEMORY_STATUSES)
      .optional()
      .describe(
        'Only count tags from memories with this status. Defaults to "active" when omitted.',
      ),
  })
  .strict();
