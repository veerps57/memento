// `memento import` — engine side. Reads a `memento-export/v1`
// JSON Lines artefact from a caller-supplied source, validates the
// header (format + schema-version handshake) and footer (SHA-256
// over preceding bytes), parses each record through the engine's
// **current** Zod schemas, and applies the result to a target
// database in a **single transaction**.
//
// Conflict policy:
//   - `skip`  : on `(scope, id)` collision, leave the existing row in
//               place and tally the skip (default; matches a "merge"
//               import).
//   - `abort` : on the first collision, roll the transaction back and
//               return `CONFLICT`.
//
// `dryRun: true` performs all parsing and footer verification but
// returns before any write — useful for validating an artefact on
// the destination machine before committing.

import { createHash } from 'node:crypto';

import {
  type Conflict,
  type ConflictEvent,
  MEMORY_SCHEMA_VERSION,
  type Memory,
  type MemoryEvent,
  MemorySchema,
  type Result,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';

import type { MementoSchema } from '../storage/index.js';
import type {
  ConflictEventsTable,
  ConflictsTable,
  MemoriesTable,
  MemoryEventsTable,
} from '../storage/schema.js';

import {
  EXPORT_FORMAT,
  type EmbeddingRecord,
  ExportFooterSchema,
  type ExportHeader,
  ExportHeaderSchema,
  ExportRecordSchema,
} from './artefact.js';

export type ImportConflictPolicy = 'skip' | 'abort';

export interface ImportOptions {
  readonly db: Kysely<MementoSchema>;
  readonly source: AsyncIterable<string> | Iterable<string>;
  readonly onConflict: ImportConflictPolicy;
  readonly dryRun: boolean;
}

export interface ImportSummary {
  readonly format: typeof EXPORT_FORMAT;
  readonly schemaVersion: number;
  readonly applied: {
    readonly memories: number;
    readonly memoryEvents: number;
    readonly conflicts: number;
    readonly conflictEvents: number;
    readonly embeddings: number;
  };
  readonly skipped: {
    readonly memories: number;
    readonly memoryEvents: number;
    readonly conflicts: number;
    readonly conflictEvents: number;
    readonly embeddings: number;
  };
  readonly dryRun: boolean;
}

interface ParsedArtefact {
  readonly header: ExportHeader;
  readonly memories: readonly Memory[];
  readonly memoryEvents: readonly MemoryEvent[];
  readonly conflicts: readonly Conflict[];
  readonly conflictEvents: readonly ConflictEvent[];
  readonly embeddings: readonly EmbeddingRecord['data'][];
}

/**
 * Read + validate an artefact and (unless `dryRun`) apply it to the
 * target database in one transaction.
 */
export async function importSnapshot(options: ImportOptions): Promise<Result<ImportSummary>> {
  const parsed = await parseArtefact(options.source);
  if (!parsed.ok) return parsed;

  if (options.dryRun) {
    return ok(buildDryRunSummary(parsed.value));
  }

  return applyArtefact(options.db, parsed.value, options.onConflict);
}

function buildDryRunSummary(parsed: ParsedArtefact): ImportSummary {
  const zero = { memories: 0, memoryEvents: 0, conflicts: 0, conflictEvents: 0, embeddings: 0 };
  return {
    format: EXPORT_FORMAT,
    schemaVersion: parsed.header.schemaVersion,
    // For dry-run, "applied" is the *would-be-applied* count — i.e.
    // the artefact's record count. Skipped is unknowable without
    // touching the DB, so it is left zero. Callers that need a
    // collision preview should run a real import on a temp DB.
    applied: {
      memories: parsed.memories.length,
      memoryEvents: parsed.memoryEvents.length,
      conflicts: parsed.conflicts.length,
      conflictEvents: parsed.conflictEvents.length,
      embeddings: parsed.embeddings.length,
    },
    skipped: zero,
    dryRun: true,
  };
}

// — Parser ——————————————————————————————————————————————————————

async function parseArtefact(
  source: AsyncIterable<string> | Iterable<string>,
): Promise<Result<ParsedArtefact>> {
  const lines: string[] = [];
  if (Symbol.asyncIterator in (source as object)) {
    for await (const line of source as AsyncIterable<string>) lines.push(line);
  } else {
    for (const line of source as Iterable<string>) lines.push(line);
  }

  if (lines.length < 2) {
    return err({
      code: 'INVALID_INPUT',
      message: 'Artefact must contain at least a header and a footer line.',
    });
  }

  const headerLine = lines[0] as string;
  const footerLine = lines[lines.length - 1] as string;
  const bodyLines = lines.slice(1, -1);

  // Footer covers every byte before the footer line (header + body
  // lines, each terminated by a single `\n`).
  const hash = createHash('sha256');
  hash.update(`${headerLine}\n`);
  for (const line of bodyLines) hash.update(`${line}\n`);
  const expectedDigest = hash.digest('hex');

  let footerJson: unknown;
  try {
    footerJson = JSON.parse(footerLine);
  } catch {
    return err({ code: 'INVALID_INPUT', message: 'Footer line is not valid JSON.' });
  }
  const footerParse = ExportFooterSchema.safeParse(footerJson);
  if (!footerParse.success) {
    return err({
      code: 'INVALID_INPUT',
      message: 'Footer line does not match the export footer schema.',
      details: footerParse.error.format(),
    });
  }
  if (footerParse.data.sha256 !== expectedDigest) {
    return err({
      code: 'INVALID_INPUT',
      message: 'Artefact integrity check failed: SHA-256 mismatch.',
      details: { expected: expectedDigest, actual: footerParse.data.sha256 },
    });
  }

  let headerJson: unknown;
  try {
    headerJson = JSON.parse(headerLine);
  } catch {
    return err({ code: 'INVALID_INPUT', message: 'Header line is not valid JSON.' });
  }
  const headerParse = ExportHeaderSchema.safeParse(headerJson);
  if (!headerParse.success) {
    return err({
      code: 'INVALID_INPUT',
      message: 'Header line does not match the export header schema.',
      details: headerParse.error.format(),
    });
  }
  const header = headerParse.data;
  if (header.schemaVersion > MEMORY_SCHEMA_VERSION) {
    return err({
      code: 'CONFIG_ERROR',
      message: `Artefact was authored against schema version ${header.schemaVersion}, but this build supports up to ${MEMORY_SCHEMA_VERSION}. Upgrade Memento on the target machine.`,
      details: { artefactSchemaVersion: header.schemaVersion, runtime: MEMORY_SCHEMA_VERSION },
    });
  }

  const memories: Memory[] = [];
  const memoryEvents: MemoryEvent[] = [];
  const conflicts: Conflict[] = [];
  const conflictEvents: ConflictEvent[] = [];
  const embeddings: EmbeddingRecord['data'][] = [];

  for (const [index, line] of bodyLines.entries()) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return err({
        code: 'INVALID_INPUT',
        message: `Record at line ${index + 2} is not valid JSON.`,
      });
    }
    const parse = ExportRecordSchema.safeParse(json);
    if (!parse.success) {
      return err({
        code: 'INVALID_INPUT',
        message: `Record at line ${index + 2} failed schema validation.`,
        details: parse.error.format(),
      });
    }
    const rec = parse.data;
    if (rec.type === 'memory') memories.push(rec.data);
    else if (rec.type === 'memory_event') memoryEvents.push(rec.data);
    else if (rec.type === 'conflict') conflicts.push(rec.data);
    else if (rec.type === 'conflict_event') conflictEvents.push(rec.data);
    else if (rec.type === 'embedding') embeddings.push(rec.data);
  }

  return ok({ header, memories, memoryEvents, conflicts, conflictEvents, embeddings });
}

// — Applier ——————————————————————————————————————————————————————

async function applyArtefact(
  db: Kysely<MementoSchema>,
  parsed: ParsedArtefact,
  policy: ImportConflictPolicy,
): Promise<Result<ImportSummary>> {
  const applied = { memories: 0, memoryEvents: 0, conflicts: 0, conflictEvents: 0, embeddings: 0 };
  const skipped = { memories: 0, memoryEvents: 0, conflicts: 0, conflictEvents: 0, embeddings: 0 };

  try {
    await db.transaction().execute(async (trx) => {
      // Pre-fetch existing ids so policy decisions don't depend on
      // catching constraint violations (which would poison the
      // transaction in SQLite).
      const existingMemoryIds = new Set(
        (await trx.selectFrom('memories').select('id').execute()).map((r) => r.id),
      );
      const existingMemoryEventIds = new Set(
        (await trx.selectFrom('memory_events').select('id').execute()).map((r) => r.id),
      );
      const existingConflictIds = new Set(
        (await trx.selectFrom('conflicts').select('id').execute()).map((r) => r.id),
      );
      const existingConflictEventIds = new Set(
        (await trx.selectFrom('conflict_events').select('id').execute()).map((r) => r.id),
      );

      const newMemoryIds = new Set<string>();
      for (const memory of parsed.memories) {
        if (existingMemoryIds.has(memory.id)) {
          if (policy === 'abort') {
            throw new ImportConflictError(`memory ${memory.id} already exists`);
          }
          skipped.memories += 1;
          continue;
        }
        await trx.insertInto('memories').values(memoryToRow(memory)).execute();
        newMemoryIds.add(memory.id);
        applied.memories += 1;
      }

      for (const event of parsed.memoryEvents) {
        if (existingMemoryEventIds.has(event.id)) {
          if (policy === 'abort') {
            throw new ImportConflictError(`memory_event ${event.id} already exists`);
          }
          skipped.memoryEvents += 1;
          continue;
        }
        // Skip orphan events (memory was skipped on conflict).
        if (!newMemoryIds.has(event.memoryId) && !existingMemoryIds.has(event.memoryId)) {
          skipped.memoryEvents += 1;
          continue;
        }
        await trx.insertInto('memory_events').values(memoryEventToRow(event)).execute();
        applied.memoryEvents += 1;
      }

      for (const conflict of parsed.conflicts) {
        if (existingConflictIds.has(conflict.id)) {
          if (policy === 'abort') {
            throw new ImportConflictError(`conflict ${conflict.id} already exists`);
          }
          skipped.conflicts += 1;
          continue;
        }
        await trx.insertInto('conflicts').values(conflictToRow(conflict)).execute();
        applied.conflicts += 1;
      }

      for (const event of parsed.conflictEvents) {
        if (existingConflictEventIds.has(event.id)) {
          if (policy === 'abort') {
            throw new ImportConflictError(`conflict_event ${event.id} already exists`);
          }
          skipped.conflictEvents += 1;
          continue;
        }
        await trx.insertInto('conflict_events').values(conflictEventToRow(event)).execute();
        applied.conflictEvents += 1;
      }

      for (const embedding of parsed.embeddings) {
        // Embeddings reference memories — skip when the underlying
        // memory was skipped or absent.
        if (!newMemoryIds.has(embedding.memoryId) && !existingMemoryIds.has(embedding.memoryId)) {
          skipped.embeddings += 1;
          continue;
        }
        await trx
          .updateTable('memories')
          .set({
            embedding_json: JSON.stringify({
              model: embedding.model,
              dimension: embedding.dimension,
              vector: embedding.vector,
              createdAt: embedding.createdAt,
            }),
          })
          .where('id', '=', embedding.memoryId)
          .execute();
        applied.embeddings += 1;
      }
    });
  } catch (error) {
    if (error instanceof ImportConflictError) {
      return err({
        code: 'CONFLICT',
        message: `Import aborted: ${error.message}.`,
      });
    }
    return err({
      code: 'STORAGE_ERROR',
      message: error instanceof Error ? error.message : 'Import failed during apply.',
    });
  }

  return ok({
    format: EXPORT_FORMAT,
    schemaVersion: parsed.header.schemaVersion,
    applied,
    skipped,
    dryRun: false,
  });
}

class ImportConflictError extends Error {}

// — Row converters (mirrors of the private repo helpers) ————————

function memoryToRow(memory: Memory): MemoriesTable {
  return {
    id: memory.id as unknown as string,
    created_at: memory.createdAt as unknown as string,
    schema_version: memory.schemaVersion,
    scope_type: memory.scope.type,
    scope_json: JSON.stringify(memory.scope),
    owner_type: memory.owner.type,
    owner_id: memory.owner.id,
    kind_type: memory.kind.type,
    kind_json: JSON.stringify(memory.kind),
    tags_json: JSON.stringify(memory.tags),
    pinned: memory.pinned ? 1 : 0,
    content: memory.content,
    summary: memory.summary,
    status: memory.status,
    stored_confidence: memory.storedConfidence,
    last_confirmed_at: memory.lastConfirmedAt as unknown as string,
    supersedes: memory.supersedes as unknown as string | null,
    superseded_by: memory.supersededBy as unknown as string | null,
    embedding_json: memory.embedding === null ? null : JSON.stringify(memory.embedding),
    client_token: null,
    sensitive: memory.sensitive ? 1 : 0,
  };
}

function memoryEventToRow(event: MemoryEvent): MemoryEventsTable {
  return {
    id: event.id as unknown as string,
    memory_id: event.memoryId as unknown as string,
    at: event.at as unknown as string,
    actor_type: event.actor.type,
    actor_json: JSON.stringify(event.actor),
    type: event.type,
    payload_json: JSON.stringify(event.payload),
    scrub_report_json: event.scrubReport === null ? null : JSON.stringify(event.scrubReport),
  };
}

function conflictToRow(c: Conflict): ConflictsTable {
  return {
    id: c.id as unknown as string,
    new_memory_id: c.newMemoryId as unknown as string,
    conflicting_memory_id: c.conflictingMemoryId as unknown as string,
    kind: c.kind,
    evidence_json: JSON.stringify(c.evidence ?? null),
    opened_at: c.openedAt as unknown as string,
    resolved_at: c.resolvedAt as unknown as string | null,
    resolution: c.resolution,
  };
}

function conflictEventToRow(e: ConflictEvent): ConflictEventsTable {
  return {
    id: e.id as unknown as string,
    conflict_id: e.conflictId as unknown as string,
    at: e.at as unknown as string,
    actor_type: e.actor.type,
    actor_json: JSON.stringify(e.actor),
    type: e.type,
    payload_json: JSON.stringify(e.payload),
  };
}

// Suppress TS unused-import; `MemorySchema` is exported as a re-use hint
// for tests / callers that want to validate header-less JSONL streams.
void MemorySchema;
