// Portability subsystem — `memento export` / `memento import`.
//
// Public entry points are kept narrow on purpose: the `exportSnapshot`
// and `importSnapshot` functions, plus the artefact schemas for
// callers that want to validate or transform JSONL streams without
// touching a database.

export { exportSnapshot } from './export.js';
export type { ExportOptions, ExportSummary, ExportWriter } from './export.js';

export { importSnapshot } from './import.js';
export type {
  ImportConflictPolicy,
  ImportOptions,
  ImportSummary,
} from './import.js';

export {
  EXPORT_FORMAT,
  ExportFooterSchema,
  ExportHeaderSchema,
  ExportRecordSchema,
  EmbeddingRecordSchema,
  MemoryRecordSchema,
  MemoryEventRecordSchema,
  ConflictRecordSchema,
  ConflictEventRecordSchema,
} from './artefact.js';
export type {
  EmbeddingRecord,
  ExportFooter,
  ExportHeader,
  ExportRecord,
} from './artefact.js';
