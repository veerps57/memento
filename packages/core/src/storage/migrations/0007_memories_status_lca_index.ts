// Migration 0007: add `(status, last_confirmed_at desc)` index on memories.
//
// Background. The existing `memories_scope_status_lca` index is
// `(scope_type, status, last_confirmed_at desc)`. With `scope_type`
// as the leading column, SQLite cannot use the index for ordered
// retrieval when the query does not constrain `scope_type` — it
// falls back to a full sort by `last_confirmed_at`. That makes
// unscoped `memory.list({limit: N})` queries scale linearly with
// corpus size.
//
// The fix is to add a complementary index whose leading column is
// `status` (the predicate every active read filters on) followed
// by `last_confirmed_at desc` (the predominant ordering). With the
// existing index keeping the scope-prefixed path fast, scoped reads
// are unaffected; unscoped reads now have an ordered-fetch path.
//
// Forward-only. No `down`: dropping the index after a deployment
// has been relying on it would silently regress unscoped list
// latency without producing a clear failure mode.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0007MemoriesStatusLcaIndex: Migration = {
  name: '0007_memories_status_lca_index',
  async up(db) {
    await sql`
      create index if not exists memories_status_lca
        on memories (status, last_confirmed_at desc)
    `.execute(db);
  },
};
