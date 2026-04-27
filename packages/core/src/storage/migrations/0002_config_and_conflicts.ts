// Migration 0002: configuration audit log + conflict tracking.
//
// Adds three current-state-and-events tables documented in
// docs/architecture/data-model.md:
//
// 1. `config_events`   — append-only audit log for `config.set` /
//                         `config.unset`. There is intentionally no
//                         `config_entries` current-state table in
//                         v1: layering is computed at read time
//                         from defaults + files + env + the latest
//                         per-key event, and the runtime cache is
//                         in-memory. Persisting only the log keeps
//                         provenance authoritative and avoids a
//                         second source of truth.
//
// 2. `conflicts`        — current state of every conflict ever
//                         opened. The current-state row is what
//                         `memento conflicts ls` reads; closing a
//                         conflict updates this row in lockstep
//                         with appending a `resolved` event.
//
// 3. `conflict_events`  — append-only lifecycle log for conflicts.
//                         Two `type`s in v1: `opened` (carries the
//                         pair + evidence) and `resolved` (carries
//                         the chosen resolution). Re-detecting a
//                         pair that was previously resolved opens
//                         a *new* conflict rather than reopening
//                         an old one; this keeps replay trivially
//                         linear.
//
// All `*_json` columns store the canonical Zod-typed value; a
// `*_type` discriminator sits beside them where filter-by-variant
// is on the read path. NULL semantics:
//
// - `config_events.old_value_json` IS NULL  ⇔ no previous value
//   (first `config.set` of that key from a runtime source). The
//   underlying Zod schema disallows `undefined`, so a JSON literal
//   `null` is stored as the four-byte string `'null'` and remains
//   distinguishable from a SQL NULL.
// - `config_events.new_value_json` IS NULL  ⇔ this event is a
//   `config.unset`.

import { sql } from 'kysely';
import type { Migration } from '../migrate.js';

export const migration0002ConfigAndConflicts: Migration = {
  name: '0002_config_and_conflicts',
  async up(db) {
    // config_events
    await sql`
      create table config_events (
        id              text not null primary key,
        key             text not null,
        old_value_json  text,
        new_value_json  text,
        source          text not null check (
          source in ('default','user-file','workspace-file','env','cli','mcp')
        ),
        actor_type      text not null check (
          actor_type in ('cli','mcp','scheduler','system')
        ),
        actor_json      text not null,
        at              text not null
      ) strict
    `.execute(db);
    // (key, at) covers the dominant read: "history for this key"
    // most-recent-first. ULID `id` is already lexicographically
    // sortable for cross-key chronological scans.
    await sql`
      create index config_events_key_at
        on config_events (key, at desc)
    `.execute(db);
    await sql`
      create index config_events_source_at
        on config_events (source, at desc)
    `.execute(db);

    // conflicts (current state).
    //
    // Both directions of the FK are pinned to memories(id); a
    // conflict whose memories never existed is a programming
    // error, not a data state to recover. The CHECKs mirror the
    // Zod refines on `ConflictSchema`.
    await sql`
      create table conflicts (
        id                       text not null primary key,
        new_memory_id            text not null references memories(id),
        conflicting_memory_id    text not null references memories(id),
        kind                     text not null check (
          kind in ('fact','preference','decision','todo','snippet')
        ),
        evidence_json            text not null,
        opened_at                text not null,
        resolved_at              text,
        resolution               text check (
          resolution in ('accept-new','accept-existing','supersede','ignore')
        ),
        check (new_memory_id <> conflicting_memory_id),
        check ((resolved_at is null) = (resolution is null)),
        check (resolved_at is null or resolved_at >= opened_at)
      ) strict
    `.execute(db);
    // Partial index over open conflicts: this is the only filter
    // `memento conflicts ls` ever applies, and the long tail of
    // resolved rows would otherwise pollute it.
    await sql`
      create index conflicts_open
        on conflicts (opened_at desc) where resolved_at is null
    `.execute(db);
    await sql`
      create index conflicts_new_memory
        on conflicts (new_memory_id)
    `.execute(db);
    await sql`
      create index conflicts_conflicting_memory
        on conflicts (conflicting_memory_id)
    `.execute(db);

    // conflict_events (append-only lifecycle log).
    await sql`
      create table conflict_events (
        id            text not null primary key,
        conflict_id   text not null references conflicts(id),
        at            text not null,
        actor_type    text not null check (
          actor_type in ('cli','mcp','scheduler','system')
        ),
        actor_json    text not null,
        type          text not null check (type in ('opened','resolved')),
        payload_json  text not null
      ) strict
    `.execute(db);
    await sql`
      create index conflict_events_conflict_at
        on conflict_events (conflict_id, at)
    `.execute(db);
    await sql`
      create index conflict_events_type_at
        on conflict_events (type, at)
    `.execute(db);
  },
};
