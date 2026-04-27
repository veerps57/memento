// Migration 0003: per-scope idempotency token for memory.write.
//
// See ADR-0012 §2 (clientToken idempotency).
//
// Adds a nullable `client_token` column to `memories` plus a
// partial unique index over (scope_json, client_token) restricted
// to active rows with a non-null token. Semantics:
//
// - The column is opaque to the entity model (`MemorySchema` does
//   not surface it). It exists purely so the repository can
//   short-circuit a duplicate `memory.write` call and return the
//   already-stored row instead of producing two memories with the
//   same intent.
// - The partial filter on `status='active'` is intentional:
//   forgetting a memory frees its token for reuse in the same
//   scope. Across scopes the same token is always allowed because
//   `scope_json` is the canonical, stable stringification of the
//   scope value (set in the repository at write time) and is part
//   of the index key.
// - The column has no CHECK on length; bounds are enforced at the
//   input schema (1..128 chars). Doing it again at the SQL layer
//   would mean two places to update for what is fundamentally an
//   ingress-validation concern.
//
// Forward-only. There is no `down`: dropping the column on a
// running deployment would discard idempotency state and is not a
// supported operation.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0003MemoryClientToken: Migration = {
  name: '0003_memory_client_token',
  async up(db) {
    await sql`alter table memories add column client_token text`.execute(db);

    // Partial unique index. SQLite supports partial indexes since
    // 3.8.0; we already require a far newer SQLite for FTS5, so
    // no version guard needed.
    await sql`
      create unique index memories_active_client_token
        on memories (scope_json, client_token)
        where status = 'active' and client_token is not null
    `.execute(db);
  },
};
