// Kysely Database interface for Memento's persisted tables.
//
// This file is the *single source of truth* for the SQL schema as
// seen from TypeScript. Every migration must keep this interface
// in lockstep with the on-disk schema; the migration test suite
// verifies the two agree by introspecting the database.
//
// Conventions:
// - `*_json` columns hold values whose canonical shape lives in
//   `@psraghuveer/memento-schema`. They are stored as TEXT and parsed at the
//   repository boundary; SQLite's `JSON1` operators are not used
//   because we never query into them — joins are by id.
// - Booleans round-trip through `0` / `1` integers (SQLite has no
//   native boolean).
// - Timestamps are ISO-8601 TEXT; ULID ids are TEXT.

/** Row shape for the `memories` table. */
export interface MemoriesTable {
  id: string;
  created_at: string;
  schema_version: number;
  scope_type: 'global' | 'workspace' | 'repo' | 'branch' | 'session';
  scope_json: string;
  owner_type: 'local' | 'team' | 'agent';
  owner_id: string;
  kind_type: 'fact' | 'preference' | 'decision' | 'todo' | 'snippet';
  kind_json: string;
  tags_json: string;
  pinned: 0 | 1;
  content: string;
  summary: string | null;
  status: 'active' | 'superseded' | 'forgotten' | 'archived';
  stored_confidence: number;
  last_confirmed_at: string;
  supersedes: string | null;
  superseded_by: string | null;
  embedding_json: string | null;
  /**
   * Per-scope idempotency token for `memory.write`. Added by
   * migration 0003. Opaque to `MemorySchema` — the entity model
   * does not surface it; the repository uses it solely to detect
   * and short-circuit duplicate writes. NULL ⇔ caller did not
   * supply a `clientToken`.
   */
  client_token: string | null;
  /**
   * Privacy flag (ADR-0012 §3). Added by migration 0004. `1`
   * marks the memory as sensitive — `memory.list` and
   * `memory.search` outputs may project it through the
   * redacted view (`content: null`, `redacted: true`) when
   * `privacy.redactSensitiveSnippets` is on. `memory.read`
   * always returns the full row regardless. Defaults to `0`
   * for back-filled rows.
   */
  sensitive: 0 | 1;
}

/** Row shape for the `memory_events` table (append-only). */
export interface MemoryEventsTable {
  id: string;
  memory_id: string;
  at: string;
  actor_type: 'cli' | 'mcp' | 'scheduler' | 'system';
  actor_json: string;
  type:
    | 'created'
    | 'confirmed'
    | 'updated'
    | 'superseded'
    | 'forgotten'
    | 'restored'
    | 'archived'
    | 'reembedded';
  payload_json: string;
  scrub_report_json: string | null;
}

/** Row shape for the `config_events` audit log (append-only). */
export interface ConfigEventsTable {
  id: string;
  key: string;
  /** SQL NULL ⇔ no previous value. JSON literal `'null'` ⇔ explicit null. */
  old_value_json: string | null;
  /** SQL NULL ⇔ this event is a `config.unset`. */
  new_value_json: string | null;
  source: 'default' | 'user-file' | 'workspace-file' | 'env' | 'cli' | 'mcp';
  actor_type: 'cli' | 'mcp' | 'scheduler' | 'system';
  actor_json: string;
  at: string;
}

/** Row shape for the `conflicts` current-state table. */
export interface ConflictsTable {
  id: string;
  new_memory_id: string;
  conflicting_memory_id: string;
  kind: 'fact' | 'preference' | 'decision' | 'todo' | 'snippet';
  evidence_json: string;
  opened_at: string;
  resolved_at: string | null;
  resolution: 'accept-new' | 'accept-existing' | 'supersede' | 'ignore' | null;
}

/** Row shape for the `conflict_events` append-only lifecycle log. */
export interface ConflictEventsTable {
  id: string;
  conflict_id: string;
  at: string;
  actor_type: 'cli' | 'mcp' | 'scheduler' | 'system';
  actor_json: string;
  type: 'opened' | 'resolved';
  payload_json: string;
}

/**
 * Full Kysely Database interface. New tables must be added here
 * **and** in a migration. Tests assert the on-disk schema matches.
 */
export interface MementoSchema {
  memories: MemoriesTable;
  memory_events: MemoryEventsTable;
  config_events: ConfigEventsTable;
  conflicts: ConflictsTable;
  conflict_events: ConflictEventsTable;
}
