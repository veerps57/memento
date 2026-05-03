// Migration registry.
//
// Append-only: add new migrations to the end of the array. Never
// edit a migration that has shipped — write a follow-up instead.
// The numeric prefix is for human ordering; the runner uses array
// order, not the prefix, so always keep the array sorted.

import type { Migration } from '../migrate.js';
import { migration0001InitialSchema } from './0001_initial_schema.js';
import { migration0002ConfigAndConflicts } from './0002_config_and_conflicts.js';
import { migration0003MemoryClientToken } from './0003_memory_client_token.js';
import { migration0004MemorySensitive } from './0004_memory_sensitive.js';
import { migration0005FtsAddTags } from './0005_fts_add_tags.js';
import { migration0006MemoryEventsImportedType } from './0006_memory_events_imported_type.js';

export const MIGRATIONS: readonly Migration[] = [
  migration0001InitialSchema,
  migration0002ConfigAndConflicts,
  migration0003MemoryClientToken,
  migration0004MemorySensitive,
  migration0005FtsAddTags,
  migration0006MemoryEventsImportedType,
];
