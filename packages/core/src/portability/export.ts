// `memento export` — engine side. Streams a `memento-export/v1`
// JSON Lines artefact to a caller-supplied writer, computing a
// streaming SHA-256 over every emitted byte (header + records) and
// closing with a footer line that carries the digest.
//
// Read path is **read-only**: the database is opened with
// `readonly: true`, so even a partial export cannot mutate state.
// Records are produced in insertion-friendly order:
//   memories → memory_events → conflicts → conflict_events → embeddings
// so that an importer applying them in stream order never violates
// foreign keys.
//
// Embeddings travel only when `includeEmbeddings: true`; the default
// strips them (per ADR-0013 §rationale: ~10× artefact size, and
// they can always be rebuilt by `memory.set_embedding`).

import { createHash } from 'node:crypto';

import { type Memory, MemorySchema } from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';

import { type MementoSchema, openDatabase } from '../storage/index.js';
import type { MemoriesTable } from '../storage/schema.js';

import {
  EXPORT_FORMAT,
  type ExportFooter,
  type ExportHeader,
  type ExportRecord,
} from './artefact.js';

/** Caller-supplied writer. One call ⇔ one terminated line. */
export interface ExportWriter {
  write(line: string): Promise<void> | void;
}

export interface ExportOptions {
  /** Filesystem path to the source SQLite database. */
  readonly dbPath: string;
  /** Sink for emitted lines (one JSON value per call, no trailing newline expected). */
  readonly writer: ExportWriter;
  /** When `true`, emit `embedding` records for every memory whose embedding is non-null. */
  readonly includeEmbeddings: boolean;
  /**
   * Memento's runtime version (e.g. `package.json#version`). Surfaces
   * in the header for forensics; not used for compatibility decisions.
   */
  readonly mementoVersion: string;
  /** Override clock for tests. Defaults to wall time. */
  readonly now?: () => Date;
}

export interface ExportSummary {
  readonly format: typeof EXPORT_FORMAT;
  readonly schemaVersion: number;
  readonly counts: ExportHeader['counts'];
  readonly sha256: string;
}

/**
 * Stream a portable artefact to `writer`. Returns the final summary
 * (counts + digest) once the footer has been emitted. Rejects only
 * on IO errors from the writer or storage layer; corrupt rows
 * surface earlier as Zod parse errors from the engine schemas.
 */
export async function exportSnapshot(options: ExportOptions): Promise<ExportSummary> {
  const now = options.now ?? (() => new Date());
  const handle = openDatabase({ path: options.dbPath, readonly: true });
  try {
    return await runExport(handle.db, options, now);
  } finally {
    handle.close();
  }
}

async function runExport(
  db: Kysely<MementoSchema>,
  options: ExportOptions,
  now: () => Date,
): Promise<ExportSummary> {
  // Step 1 — read everything we need into memory, so the header's
  // counts are accurate (we cannot rewind a streaming writer to
  // patch them retroactively). Memento databases targeted by P1.4
  // /P1.15 are personal-scale (≤ 100k rows), so a single pass is
  // affordable; if that ever changes the design upgrade is to emit
  // the header as a deferred descriptor and write it last.
  const memoryRows = await db.selectFrom('memories').selectAll().execute();
  const memoryEventRows = await db.selectFrom('memory_events').selectAll().execute();
  const conflictRows = await db.selectFrom('conflicts').selectAll().execute();
  const conflictEventRows = await db.selectFrom('conflict_events').selectAll().execute();

  const memories = memoryRows.map(rowToMemory);
  const memoryEvents = memoryEventRows.map((row) => ({
    id: row.id,
    memoryId: row.memory_id,
    at: row.at,
    actor: JSON.parse(row.actor_json) as unknown,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    scrubReport: row.scrub_report_json === null ? null : JSON.parse(row.scrub_report_json),
  }));
  const conflicts = conflictRows.map((row) => ({
    id: row.id,
    newMemoryId: row.new_memory_id,
    conflictingMemoryId: row.conflicting_memory_id,
    kind: row.kind,
    evidence: JSON.parse(row.evidence_json) as unknown,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  }));
  const conflictEvents = conflictEventRows.map((row) => ({
    id: row.id,
    conflictId: row.conflict_id,
    at: row.at,
    actor: JSON.parse(row.actor_json) as unknown,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
  }));

  // Schema version is the value the source DB has migrated to; we
  // read it from any one parsed memory (or fall back to the import
  // sentinel `1` for an empty DB).
  const schemaVersion = memories[0]?.schemaVersion ?? 1;

  let embeddingsCount = 0;
  if (options.includeEmbeddings) {
    for (const memory of memories) {
      if (memory.embedding !== null) embeddingsCount += 1;
    }
  }
  let sensitiveCount = 0;
  for (const memory of memories) if (memory.sensitive) sensitiveCount += 1;

  // Step 2 — serialise.
  const hash = createHash('sha256');
  const writeLine = async (value: unknown): Promise<void> => {
    const line = `${JSON.stringify(value)}\n`;
    hash.update(line);
    await options.writer.write(line);
  };

  const header: ExportHeader = {
    type: 'header',
    format: EXPORT_FORMAT,
    schemaVersion,
    mementoVersion: options.mementoVersion,
    exportedAt: now().toISOString() as ExportHeader['exportedAt'],
    includeEmbeddings: options.includeEmbeddings,
    counts: {
      memories: memories.length,
      memoryEvents: memoryEvents.length,
      conflicts: conflicts.length,
      conflictEvents: conflictEvents.length,
      embeddings: embeddingsCount,
      sensitive: sensitiveCount,
    },
  };
  await writeLine(header);

  for (const memory of memories) {
    // Memory records strip the inline embedding even when present
    // — embeddings always travel in their own record stream so an
    // importer can decide whether to apply them.
    const { embedding: _embedding, ...rest } = memory;
    const record: ExportRecord = { type: 'memory', data: { ...rest, embedding: null } };
    await writeLine(record);
  }
  for (const event of memoryEvents) {
    const record: ExportRecord = { type: 'memory_event', data: event as never };
    await writeLine(record);
  }
  for (const conflict of conflicts) {
    const record: ExportRecord = { type: 'conflict', data: conflict as never };
    await writeLine(record);
  }
  for (const event of conflictEvents) {
    const record: ExportRecord = { type: 'conflict_event', data: event as never };
    await writeLine(record);
  }
  if (options.includeEmbeddings) {
    for (const memory of memories) {
      if (memory.embedding === null) continue;
      const record: ExportRecord = {
        type: 'embedding',
        data: {
          memoryId: memory.id,
          model: memory.embedding.model,
          dimension: memory.embedding.dimension,
          vector: memory.embedding.vector,
          createdAt: memory.embedding.createdAt,
        },
      };
      await writeLine(record);
    }
  }

  // Footer: the digest covers every byte before this line.
  const sha256 = hash.digest('hex');
  const footer: ExportFooter = { type: 'footer', sha256 };
  await options.writer.write(`${JSON.stringify(footer)}\n`);

  return {
    format: EXPORT_FORMAT,
    schemaVersion,
    counts: header.counts,
    sha256,
  };
}

// `rowToMemory` is duplicated here with the same shape as the
// private converter in `memory-repository.ts`, to avoid widening
// the repository's public surface for what is otherwise a one-off
// integration. Drift risk is bounded: both converters parse through
// `MemorySchema`, so any column added in a future migration without
// updating both will fail loudly on the first export.
function rowToMemory(row: MemoriesTable): Memory {
  return MemorySchema.parse({
    id: row.id,
    createdAt: row.created_at,
    schemaVersion: row.schema_version,
    scope: JSON.parse(row.scope_json),
    owner: { type: row.owner_type, id: row.owner_id },
    kind: JSON.parse(row.kind_json),
    tags: JSON.parse(row.tags_json),
    pinned: row.pinned === 1,
    content: row.content,
    summary: row.summary,
    status: row.status,
    storedConfidence: row.stored_confidence,
    lastConfirmedAt: row.last_confirmed_at,
    supersedes: row.supersedes,
    supersededBy: row.superseded_by,
    embedding: row.embedding_json === null ? null : JSON.parse(row.embedding_json),
    sensitive: row.sensitive === 1,
  });
}
