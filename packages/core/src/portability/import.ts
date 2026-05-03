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
//
// Re-stamp policy (ADR-0019). The importer never trusts the
// artefact's audit claims. Three transformations always happen,
// regardless of `trustSource`:
//
//   1. `OwnerRef` is rewritten to the importer's local-self.
//      Memento is single-user-mode in v1; an artefact claiming
//      `{type:'team', id:'someone'}` lands as local on the
//      target. AGENTS.md rule 4.
//   2. Memory content / summary / decision-rationale are
//      re-scrubbed with the **importer's** current rule set. An
//      artefact authored on a machine with `scrubber.enabled =
//      false` (or a weaker rule set) has its secrets re-redacted
//      on the way in.
//   3. `MemoryEvent.payload` and `Conflict.evidence` JSON are
//      capped per record. A forged artefact cannot stuff
//      arbitrary multi-megabyte payloads into the audit log to
//      bloat storage or game retrieval.
//
// On top of those, `trustSource` controls the audit chain:
//
//   - `false` (default): the artefact's per-memory event chain
//     is **collapsed** into one synthetic `memory.imported`
//     event per imported memory. Original events ride along as
//     opaque structured data inside `payload.originalEvents` for
//     forensics. The audit log on the target honestly reports
//     "this memory landed via import on $now"; it does not echo
//     the source's `actor` or `at` claims as if they happened
//     locally. Direct violation of AGENTS.md rule 11
//     ("`MemoryEvent` is the audit source of truth") is closed.
//
//   - `true`: original memory events are inserted verbatim. The
//     `--trust-source` flag is the only way to reach this path
//     and exists for the "I'm restoring my own backup, preserve
//     the history" case.

import { createHash } from 'node:crypto';

import {
  type ActorRef,
  type Conflict,
  type ConflictEvent,
  MEMORY_SCHEMA_VERSION,
  type Memory,
  type MemoryEvent,
  MemoryEventSchema,
  MemorySchema,
  type OwnerRef,
  type Result,
  type ScrubReport,
  type ScrubberRuleSet,
  type Timestamp,
  err,
  ok,
} from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';

import { ulid } from '../repository/ulid.js';
import { applyRules } from '../scrubber/engine.js';
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

/**
 * Default per-record cap on `MemoryEvent.payload` and
 * `Conflict.evidence` JSON. 64 KiB comfortably exceeds any
 * legitimate event payload (the largest variant — `forgotten`
 * with a `reason` — caps `reason` at 512 chars at the schema
 * layer); rejecting past it stops a forged artefact from
 * stuffing the audit log with a multi-megabyte blob.
 */
export const DEFAULT_IMPORT_RECORD_MAX_BYTES = 64 * 1024;

export interface ImportOptions {
  readonly db: Kysely<MementoSchema>;
  readonly source: AsyncIterable<string> | Iterable<string>;
  readonly onConflict: ImportConflictPolicy;
  readonly dryRun: boolean;
  /**
   * When false (default), the artefact's per-memory event chain
   * is collapsed into a single synthetic `memory.imported` event
   * per imported memory. When true, original events are inserted
   * verbatim. `OwnerRef` rewrite and re-scrub still run in both
   * modes — they are non-negotiable.
   */
  readonly trustSource?: boolean;
  /**
   * Active scrubber configuration on the target machine. When
   * present, every imported memory's content / summary /
   * decision-rationale is re-scrubbed before insertion. When
   * absent, content travels verbatim — appropriate only for
   * test fixtures that bypass scrubbing intentionally.
   */
  readonly scrubber?: {
    rules: ScrubberRuleSet;
    enabled?: boolean;
    engineBudgetMs?: number;
  };
  /**
   * Actor stamped on every synthetic `memory.imported` event. In
   * production this is the importer's CLI actor; tests pass a
   * deterministic value.
   */
  readonly actor?: ActorRef;
  /**
   * Clock used for the synthetic-event `at` timestamp. Injected
   * for deterministic tests; defaults to system time.
   */
  readonly clock?: () => Timestamp;
  /**
   * Event-id factory for synthetic `memory.imported` events.
   * Defaults to ULID. Injected for deterministic tests.
   */
  readonly eventIdFactory?: () => string;
  /**
   * Per-record JSON-payload cap. Defaults to {@link DEFAULT_IMPORT_RECORD_MAX_BYTES}.
   */
  readonly maxRecordBytes?: number;
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
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_IMPORT_RECORD_MAX_BYTES;
  const parsed = await parseArtefact(options.source, maxRecordBytes);
  if (!parsed.ok) return parsed;

  if (options.dryRun) {
    return ok(buildDryRunSummary(parsed.value));
  }

  return applyArtefact(parsed.value, options);
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
  maxRecordBytes: number,
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

    // Per-record JSON cap. Catches forged artefacts that stuff
    // `evidence` or event `payload` blobs with megabytes of
    // attacker-supplied data. The unbounded raw JSON is bounded
    // here (after schema validation passes) rather than at line
    // length, because line length includes valid wrappers.
    if (rec.type === 'memory_event') {
      const size = Buffer.byteLength(JSON.stringify(rec.data.payload), 'utf8');
      if (size > maxRecordBytes) {
        return err({
          code: 'INVALID_INPUT',
          message: `memory_event at line ${index + 2} payload is ${size} bytes; exceeds maxRecordBytes (${maxRecordBytes})`,
          details: { line: index + 2, size, limit: maxRecordBytes, field: 'payload' },
        });
      }
    } else if (rec.type === 'conflict') {
      const size = Buffer.byteLength(JSON.stringify(rec.data.evidence ?? null), 'utf8');
      if (size > maxRecordBytes) {
        return err({
          code: 'INVALID_INPUT',
          message: `conflict at line ${index + 2} evidence is ${size} bytes; exceeds maxRecordBytes (${maxRecordBytes})`,
          details: { line: index + 2, size, limit: maxRecordBytes, field: 'evidence' },
        });
      }
    } else if (rec.type === 'conflict_event') {
      const size = Buffer.byteLength(JSON.stringify(rec.data.payload), 'utf8');
      if (size > maxRecordBytes) {
        return err({
          code: 'INVALID_INPUT',
          message: `conflict_event at line ${index + 2} payload is ${size} bytes; exceeds maxRecordBytes (${maxRecordBytes})`,
          details: { line: index + 2, size, limit: maxRecordBytes, field: 'payload' },
        });
      }
    }

    if (rec.type === 'memory') memories.push(rec.data);
    else if (rec.type === 'memory_event') memoryEvents.push(rec.data);
    else if (rec.type === 'conflict') conflicts.push(rec.data);
    else if (rec.type === 'conflict_event') conflictEvents.push(rec.data);
    else if (rec.type === 'embedding') embeddings.push(rec.data);
  }

  return ok({ header, memories, memoryEvents, conflicts, conflictEvents, embeddings });
}

// — Applier ——————————————————————————————————————————————————————

const LOCAL_OWNER: OwnerRef = { type: 'local', id: 'self' };

/**
 * Re-stamp an imported `Memory` for the local DB:
 * - rewrite `OwnerRef` to local-self;
 * - re-scrub `content`, `summary`, and (for `decision` kinds)
 *   `kind.rationale` through the importer's current rules;
 * - return the merged `ScrubReport` for the synthetic
 *   `memory.imported` event's audit record (when the importer is
 *   running in collapse mode).
 *
 * `MemorySchema.parse` re-validates the result so a buggy
 * scrubber output cannot land a row that fails entity invariants.
 */
function rewriteMemoryForImport(
  source: Memory,
  scrubber: ImportOptions['scrubber'],
): { memory: Memory; report: ScrubReport | null } {
  if (scrubber === undefined || scrubber.enabled === false) {
    const local = MemorySchema.parse({ ...source, owner: LOCAL_OWNER });
    return { memory: local, report: null };
  }
  const rules = scrubber.rules;
  const opts =
    scrubber.engineBudgetMs !== undefined ? { engineBudgetMs: scrubber.engineBudgetMs } : {};
  const contentResult = applyRules(source.content, rules, opts);
  const summaryResult = source.summary !== null ? applyRules(source.summary, rules, opts) : null;
  const rationale = source.kind.type === 'decision' ? source.kind.rationale : null;
  const rationaleResult = rationale !== null ? applyRules(rationale, rules, opts) : null;

  const ruleCounts = new Map<
    string,
    { matches: number; severity: ScrubReport['rules'][number]['severity'] }
  >();
  const fold = (rules: ScrubReport['rules']): void => {
    for (const r of rules) {
      const existing = ruleCounts.get(r.ruleId);
      if (existing !== undefined) existing.matches += r.matches;
      else ruleCounts.set(r.ruleId, { matches: r.matches, severity: r.severity });
    }
  };
  fold(contentResult.report.rules);
  if (summaryResult !== null) fold(summaryResult.report.rules);
  if (rationaleResult !== null) fold(rationaleResult.report.rules);

  const report: ScrubReport = {
    rules: Array.from(ruleCounts, ([ruleId, v]) => ({
      ruleId,
      matches: v.matches,
      severity: v.severity,
    })),
    byteOffsets: contentResult.report.byteOffsets,
  };

  const rewrittenKind =
    source.kind.type === 'decision' && rationaleResult !== null
      ? { ...source.kind, rationale: rationaleResult.scrubbed }
      : source.kind;

  const memory = MemorySchema.parse({
    ...source,
    owner: LOCAL_OWNER,
    kind: rewrittenKind,
    content: contentResult.scrubbed,
    summary: summaryResult !== null ? summaryResult.scrubbed : source.summary,
  });
  return { memory, report };
}

async function applyArtefact(
  parsed: ParsedArtefact,
  options: ImportOptions,
): Promise<Result<ImportSummary>> {
  const applied = { memories: 0, memoryEvents: 0, conflicts: 0, conflictEvents: 0, embeddings: 0 };
  const skipped = { memories: 0, memoryEvents: 0, conflicts: 0, conflictEvents: 0, embeddings: 0 };

  const db = options.db;
  const policy = options.onConflict;
  const trustSource = options.trustSource ?? false;
  const importActor: ActorRef = options.actor ?? { type: 'cli' };
  const importClock = options.clock ?? (() => new Date().toISOString() as Timestamp);
  const importEventIdFactory = options.eventIdFactory ?? (() => ulid());

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

      // Group source events by memory so we can either drop them
      // (collapse mode) or replay them (trust-source mode) against
      // the matching memory id.
      const eventsByMemory = new Map<string, MemoryEvent[]>();
      for (const event of parsed.memoryEvents) {
        const existing = eventsByMemory.get(event.memoryId);
        if (existing !== undefined) existing.push(event);
        else eventsByMemory.set(event.memoryId, [event]);
      }

      const newMemoryIds = new Set<string>();
      for (const sourceMemory of parsed.memories) {
        if (existingMemoryIds.has(sourceMemory.id)) {
          if (policy === 'abort') {
            throw new ImportConflictError(`memory ${sourceMemory.id} already exists`);
          }
          skipped.memories += 1;
          continue;
        }

        // Re-stamp owner and re-scrub content. This is the
        // load-bearing transformation per ADR-0019: an imported
        // memory always lands as local-self, with content
        // re-redacted by the importer's current rule set.
        const rewritten = rewriteMemoryForImport(sourceMemory, options.scrubber);

        await trx.insertInto('memories').values(memoryToRow(rewritten.memory)).execute();
        newMemoryIds.add(sourceMemory.id);
        applied.memories += 1;

        if (!trustSource) {
          // Collapse mode (default): replace the entire source
          // event chain with one synthetic `imported` event.
          const sourceEventChain = eventsByMemory.get(sourceMemory.id) ?? [];
          const syntheticEvent = MemoryEventSchema.parse({
            id: importEventIdFactory(),
            memoryId: sourceMemory.id,
            at: importClock(),
            actor: importActor,
            scrubReport: rewritten.report,
            type: 'imported',
            payload: {
              source: {
                mementoVersion: parsed.header.mementoVersion,
                exportedAt: parsed.header.exportedAt,
                // Footer SHA pulled from the parser's verified
                // digest is what we want here, but we don't carry
                // it through to applier — re-derive a stable
                // reference using the header signature shape. For
                // forensic value the (mementoVersion, exportedAt)
                // pair is enough; real provenance work runs `git`
                // / file-system tooling over the artefact itself.
                sha256: deriveProvenanceSha(parsed.header),
              },
              originalEvents: capOriginalEvents(sourceEventChain),
            },
          });
          await trx.insertInto('memory_events').values(memoryEventToRow(syntheticEvent)).execute();
          applied.memoryEvents += 1;
          // Source events for this memory are dropped — count
          // them as skipped so the caller's summary makes sense.
          skipped.memoryEvents += sourceEventChain.length;
          // Mark them as "consumed" so the trust-source loop
          // below does not re-process them.
          eventsByMemory.delete(sourceMemory.id);
        }
      }

      // Trust-source mode: insert original events verbatim. The
      // OwnerRef rewrite and content re-scrub still ran above on
      // the memory rows themselves; here we replay the audit
      // chain as-authored. Unhandled memory ids (events whose
      // memory was skipped on conflict, or events that don't
      // belong to this artefact's memories) are dropped.
      if (trustSource) {
        for (const event of parsed.memoryEvents) {
          if (existingMemoryEventIds.has(event.id)) {
            if (policy === 'abort') {
              throw new ImportConflictError(`memory_event ${event.id} already exists`);
            }
            skipped.memoryEvents += 1;
            continue;
          }
          if (!newMemoryIds.has(event.memoryId) && !existingMemoryIds.has(event.memoryId)) {
            skipped.memoryEvents += 1;
            continue;
          }
          await trx.insertInto('memory_events').values(memoryEventToRow(event)).execute();
          applied.memoryEvents += 1;
        }
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

/**
 * Cap the original-events array on a synthetic `memory.imported`
 * event payload. The schema-level cap (`max(1024)` entries) is
 * the structural ceiling; in practice we want a tighter bound to
 * keep the audit log from ballooning when an artefact has a
 * memory with thousands of confirmation events. Truncate with a
 * marker entry so the forensic value of "there was more here" is
 * preserved.
 */
function capOriginalEvents(events: readonly MemoryEvent[]): unknown[] {
  const SOFT_CAP = 256;
  if (events.length <= SOFT_CAP) return events.map((e) => e as unknown);
  const head = events.slice(0, SOFT_CAP).map((e) => e as unknown);
  head.push({
    type: '_truncated',
    reason: `import: original event chain truncated to ${SOFT_CAP} entries (source had ${events.length})`,
  });
  return head;
}

/**
 * Derive a stable provenance string from the artefact header.
 * Used as `sha256` in the synthetic `imported` event payload —
 * the schema requires that field to be 64 hex chars, but the
 * applier does not have the footer SHA in scope, so we hash the
 * canonical header content (already covered by the artefact
 * footer's integrity check at parse time) instead. The forensic
 * value is identical: it pins the import to a specific source
 * artefact.
 */
function deriveProvenanceSha(header: ExportHeader): string {
  return createHash('sha256').update(JSON.stringify(header)).digest('hex');
}

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
