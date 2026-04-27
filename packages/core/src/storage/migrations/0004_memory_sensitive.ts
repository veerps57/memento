// Migration 0004: per-memory `sensitive` privacy flag.
//
// See ADR-0012 §3 (`sensitive` flag + `privacy.redactSensitiveSnippets`).
//
// Adds a non-nullable `sensitive INTEGER` column to `memories`,
// defaulting to `0` (false). `memory.write` and `memory.update`
// callers can flip it; `memory.list` and `memory.search` honour
// it by projecting matching rows through the redacted view when
// the `privacy.redactSensitiveSnippets` config is on.
//
// The column is `INTEGER` rather than a Kysely-side boolean
// because SQLite has no native boolean — every other boolean
// column on `memories` (`pinned`) follows the same 0/1
// convention. NOT NULL DEFAULT 0 means existing rows are
// safely back-filled to "not sensitive" without a separate
// data-migration pass.
//
// Forward-only. There is no `down`: dropping the flag on a
// running deployment would unmask sensitive content in search
// and list outputs and is not a supported operation.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0004MemorySensitive: Migration = {
  name: '0004_memory_sensitive',
  async up(db) {
    await sql`alter table memories add column sensitive integer not null default 0`.execute(db);
  },
};
