// FTS5 candidate generation.
//
// SQLite's FTS5 module is the always-on text-relevance backbone
// per `docs/architecture/retrieval.md`. This module produces a
// list of `(memoryId, bm25Score)` candidates honouring the
// caller's status / kind / scope filters, capped at
// `retrieval.candidate.ftsLimit` so the post-ranker work is
// bounded.
//
// Two non-obvious behaviours documented up front:
//
// 1. Query sanitisation. FTS5 MATCH expressions support phrase,
//    prefix, NEAR, AND/OR/NOT operators, and column-prefix
//    syntax. Surfacing these to MCP / CLI callers verbatim is a
//    quoting hazard — a stray `"` or `:` raises a confusing
//    runtime error and an attacker-controlled query can mine
//    error text for index shape. So we strip FTS5 sigils
//    (`"` `'` `:` `(` `)` `*` `^`), tokenise on whitespace, wrap
//    each surviving token in double quotes, and OR them
//    together. The result is interpreted as a term-bag — the
//    most common shape for a search box. Power users who want
//    the full FTS5 query language will get it via a future
//    `retrieval.searchSyntax` config (v1.1).
//
// 2. We compose the SQL by hand rather than through Kysely's
//    builder because the FTS5 virtual table is not part of the
//    typed `MementoSchema` (it has no fixed column shape). User
//    values are bound as parameters via `${}`; identifiers come
//    exclusively from enums / fixed lists in this file.

import type { MemoryId, MemoryKindType, Scope } from '@psraghuveer/memento-schema';
import { type Kysely, sql } from 'kysely';
import type { MementoSchema } from '../storage/schema.js';

export interface FtsSearchOptions {
  readonly text: string;
  readonly limit: number;
  readonly statuses: readonly ('active' | 'superseded' | 'forgotten' | 'archived')[];
  readonly kinds?: readonly MemoryKindType[];
  readonly scopes?: readonly Scope[];
}

export interface FtsHit {
  readonly id: MemoryId;
  readonly bm25: number;
}

const FTS5_SIGIL_PATTERN = /["':()*^]/g;
const TOKEN_SPLIT_PATTERN = /\s+/u;

/**
 * Strip FTS5 syntax from a user query so it parses as a plain
 * term bag. Returns an empty string when the sanitised query
 * has no tokens; callers should treat that as "no FTS match"
 * and skip the search rather than emit `MATCH ''` (which FTS5
 * rejects with a confusing parser error).
 */
export function sanitizeFtsQuery(text: string): string {
  return text
    .replace(FTS5_SIGIL_PATTERN, ' ')
    .split(TOKEN_SPLIT_PATTERN)
    .filter((tok) => tok.length > 0)
    .map((tok) => `"${tok}"`)
    .join(' OR ');
}

/**
 * Run an FTS5 query and return at most `limit` hits ordered by
 * `bm25()` ascending (most-relevant first).
 *
 * Status / kind / scope filters are applied as JOIN-side WHERE
 * clauses; FTS hits whose memory does not match are dropped
 * before the limit is applied. That keeps the candidate count
 * honest — the caller asked for up to N matching candidates,
 * not N FTS hits some of which the ranker would throw away.
 */
export async function searchFts(
  db: Kysely<MementoSchema>,
  options: FtsSearchOptions,
): Promise<FtsHit[]> {
  const cleaned = sanitizeFtsQuery(options.text);
  if (cleaned === '') {
    return [];
  }
  if (options.statuses.length === 0) {
    return [];
  }
  if (options.scopes !== undefined && options.scopes.length === 0) {
    return [];
  }
  if (options.kinds !== undefined && options.kinds.length === 0) {
    return [];
  }

  const statusList = sql.join(options.statuses.map((s) => sql.lit(s)));

  const kindClause =
    options.kinds === undefined
      ? sql``
      : sql` and m.kind_type in (${sql.join(options.kinds.map((k) => sql.lit(k)))})`;

  const scopeClause =
    options.scopes === undefined
      ? sql``
      : sql` and (${sql.join(
          options.scopes.map(
            (scope) =>
              sql`(m.scope_type = ${scope.type} and m.scope_json = ${JSON.stringify(scope)})`,
          ),
          sql` or `,
        )})`;

  const result = await sql<{ id: string; bm25: number }>`
    select m.id as id, bm25(memories_fts) as bm25
    from memories_fts
    join memories_fts_map map on map.rowid = memories_fts.rowid
    join memories m on m.id = map.memory_id
    where memories_fts match ${cleaned}
      and m.status in (${statusList})${kindClause}${scopeClause}
    order by bm25(memories_fts) asc
    limit ${options.limit}
  `.execute(db);

  return result.rows.map((row) => ({
    id: row.id as unknown as MemoryId,
    bm25: row.bm25,
  }));
}
