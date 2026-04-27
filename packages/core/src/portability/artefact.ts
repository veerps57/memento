// Portable export/import artefact format (`memento-export/v1`).
//
// Per ADR-0013. The on-disk artefact is **JSON Lines**: one JSON
// value per line. The first line is a header, the last line is a
// footer carrying a SHA-256 over every preceding byte; everything
// in between is a discriminated stream of `memory`, `memory_event`,
// `conflict`, `conflict_event`, and (optionally) `embedding`
// records.
//
// This module owns the wire-level Zod schemas. The `export.ts` and
// `import.ts` siblings own the IO orchestration; together they form
// the portability subsystem invoked by `memento export` / `memento
// import` (per P1.4 + P1.15).

import {
  ConflictEventSchema,
  ConflictSchema,
  MemoryEventSchema,
  MemoryIdSchema,
  MemorySchema,
  TimestampSchema,
} from '@psraghuveer/memento-schema';
import { z } from 'zod';

/** Wire literal for `header.format`. Bump only on a breaking change. */
export const EXPORT_FORMAT = 'memento-export/v1' as const;

/**
 * Header is the first line of an artefact. Everything downstream
 * relies on `format` + `schemaVersion` to decide whether to keep
 * reading, so this schema is `.strict()` — unknown fields are an
 * authoring bug, not a forward-compat hint.
 */
export const ExportHeaderSchema = z
  .object({
    type: z.literal('header'),
    format: z.literal(EXPORT_FORMAT),
    schemaVersion: z.number().int().positive(),
    mementoVersion: z.string().min(1),
    exportedAt: TimestampSchema,
    includeEmbeddings: z.boolean(),
    counts: z
      .object({
        memories: z.number().int().nonnegative(),
        memoryEvents: z.number().int().nonnegative(),
        conflicts: z.number().int().nonnegative(),
        conflictEvents: z.number().int().nonnegative(),
        embeddings: z.number().int().nonnegative(),
        sensitive: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ExportHeader = z.infer<typeof ExportHeaderSchema>;

/**
 * The four entity records that always travel verbatim. They delegate
 * to the existing entity Zod schemas, which means import-side
 * validation is exactly as strict as the engine's runtime checks —
 * an artefact authored against a future schema version with extra
 * fields will be rejected loudly.
 */
export const MemoryRecordSchema = z
  .object({ type: z.literal('memory'), data: MemorySchema })
  .strict();
export const MemoryEventRecordSchema = z
  .object({ type: z.literal('memory_event'), data: MemoryEventSchema })
  .strict();
export const ConflictRecordSchema = z
  .object({ type: z.literal('conflict'), data: ConflictSchema })
  .strict();
export const ConflictEventRecordSchema = z
  .object({ type: z.literal('conflict_event'), data: ConflictEventSchema })
  .strict();

/**
 * Embedding records travel separately so a default export stays
 * model-agnostic and ~10× smaller. The `data` payload deliberately
 * mirrors the engine's internal `Embedding` shape plus the
 * `memoryId` it attaches to.
 */
export const EmbeddingRecordSchema = z
  .object({
    type: z.literal('embedding'),
    data: z
      .object({
        memoryId: MemoryIdSchema,
        model: z.string().min(1),
        dimension: z.number().int().positive(),
        vector: z.array(z.number()),
        createdAt: TimestampSchema,
      })
      .strict()
      .refine((v) => v.vector.length === v.dimension, {
        message: 'embedding.vector.length must equal embedding.dimension',
      }),
  })
  .strict();
export type EmbeddingRecord = z.infer<typeof EmbeddingRecordSchema>;

/**
 * Footer line. `sha256` is the lowercase hex SHA-256 of every byte
 * emitted before this line, *including* the trailing newline that
 * closes the previous record. The footer line itself is NOT covered.
 */
export const ExportFooterSchema = z
  .object({
    type: z.literal('footer'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ExportFooter = z.infer<typeof ExportFooterSchema>;

/** Discriminated union of every line that is *not* the header/footer. */
export const ExportRecordSchema = z.discriminatedUnion('type', [
  MemoryRecordSchema,
  MemoryEventRecordSchema,
  ConflictRecordSchema,
  ConflictEventRecordSchema,
  EmbeddingRecordSchema,
]);
export type ExportRecord = z.infer<typeof ExportRecordSchema>;
