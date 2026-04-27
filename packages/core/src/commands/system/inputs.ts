// Wire-shape input schemas for the `system.*` command set.
//
// Both commands here are read-only introspection probes whose
// inputs are intentionally minimal: an MCP-capable assistant
// should be able to call them with no arguments. Optional
// filters are added only when they avoid forcing the caller to
// post-filter a large response.

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
