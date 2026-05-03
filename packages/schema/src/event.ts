import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { MemoryKindSchema } from './memory.js';
import { EventIdSchema, MemoryIdSchema, TimestampSchema } from './primitives.js';
import { TagSchema } from './primitives.js';

/**
 * `ScrubberRuleSeverity` mirrors the levels the scrubber assigns to
 * each rule. Severity is metadata only; it does not gate writes.
 */
export const SCRUBBER_RULE_SEVERITIES = ['low', 'medium', 'high'] as const;
export const ScrubberRuleSeveritySchema = z.enum(SCRUBBER_RULE_SEVERITIES);
export type ScrubberRuleSeverity = z.infer<typeof ScrubberRuleSeveritySchema>;

/**
 * `ScrubReport` records what the scrubber did to the candidate
 * content during a write. It captures:
 *
 * - per-rule match counts and severities, so audits can answer "did
 *   any high-severity rule fire on this memory?";
 * - byte-offset pairs `[start, end)` of every match in the pre-scrub
 *   content so a privacy reviewer can re-run the regex on a fresh
 *   sample and verify behaviour without ever persisting the secret.
 *
 * The pre-scrub content itself is **never** stored; only the report.
 */
export const ScrubReportSchema = z
  .object({
    rules: z.array(
      z
        .object({
          ruleId: z.string().min(1).max(128),
          matches: z.number().int().min(1),
          severity: ScrubberRuleSeveritySchema,
        })
        .strict(),
    ),
    byteOffsets: z.array(
      z
        .tuple([z.number().int().min(0), z.number().int().min(0)])
        .refine(([start, end]) => end > start, {
          message: 'byte-offset end must be > start',
        }),
    ),
  })
  .strict();

export type ScrubReport = z.infer<typeof ScrubReportSchema>;

/**
 * `MemoryEventType` enumerates the kinds of events recorded against
 * a memory. The audit log is append-only, so this set defines the
 * shape of the long-running history of every memory.
 *
 * - `created`     — memory written for the first time.
 * - `confirmed`   — caller affirmed the memory is still correct.
 * - `updated`     — taxonomy mutation (tags / kind / pinned only).
 * - `superseded`  — replaced by a newer memory; payload links it.
 * - `forgotten`   — soft-removed from active retrieval.
 * - `restored`    — moved back to `active` from `forgotten`.
 * - `archived`    — moved to long-term storage; off active reads.
 * - `reembedded`  — embedding regenerated (model / dimension change).
 * - `imported`    — memory landed via `memento import`. The
 *                   importer never trusts caller-supplied audit
 *                   events — by default the entire source event
 *                   chain is collapsed into a single `imported`
 *                   event whose payload retains the source
 *                   provenance (artefact metadata + opaque
 *                   original chain) for forensics. `--trust-source`
 *                   replays the original events instead.
 */
export const MEMORY_EVENT_TYPES = [
  'created',
  'confirmed',
  'updated',
  'superseded',
  'forgotten',
  'restored',
  'archived',
  'reembedded',
  'imported',
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

const MemoryUpdatePatchSchema = z
  .object({
    tags: z.array(TagSchema).optional(),
    kind: MemoryKindSchema.optional(),
    pinned: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.tags !== undefined ||
      p.kind !== undefined ||
      p.pinned !== undefined ||
      p.sensitive !== undefined,
    {
      message: 'updated event payload must change at least one field',
    },
  );

const eventBase = {
  id: EventIdSchema,
  memoryId: MemoryIdSchema,
  at: TimestampSchema,
  actor: ActorRefSchema,
  scrubReport: ScrubReportSchema.nullable(),
};

/**
 * `MemoryEvent` is a single entry in the append-only audit log. The
 * `payload` is typed by `type`; each variant captures exactly the
 * information needed to reconstruct that event's effect.
 *
 * Notes on payload design:
 *
 * - `confirmed`, `restored`, `archived` carry no payload — the
 *   timestamp + type is the entire event.
 * - `updated` carries a partial patch over the mutable-taxonomy
 *   fields and rejects empty patches at parse time.
 * - `superseded` links forward to the replacement memory; the
 *   reverse pointer lives on the memory row.
 * - `forgotten` carries an optional, free-form `reason`.
 * - `reembedded` records the new model + dimension so that a
 *   later "should I rebuild?" check is a row-level decision.
 */
export const MemoryEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...eventBase,
      type: z.literal('created'),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('confirmed'),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('updated'),
      payload: MemoryUpdatePatchSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('superseded'),
      payload: z
        .object({
          replacementId: MemoryIdSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('forgotten'),
      payload: z
        .object({
          reason: z.string().max(512).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('restored'),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('archived'),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('reembedded'),
      payload: z
        .object({
          model: z.string().min(1).max(128),
          dimension: z.number().int().positive().max(4096),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('imported'),
      payload: z
        .object({
          // Provenance of the source artefact. `sha256` is the
          // artefact-footer hash so a forensic reviewer can tie
          // the imported memory back to a specific export run.
          source: z
            .object({
              mementoVersion: z.string().min(1).max(64),
              exportedAt: TimestampSchema,
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            })
            .strict(),
          // The original event chain from the source artefact,
          // retained as opaque structured data for forensics.
          // The importer does not (and must not) replay these
          // as live events under the default re-stamp policy
          // — the bytes here are evidence, not history. The
          // `--trust-source` flag instead inserts the original
          // events directly and skips emitting an `imported`
          // event, so when this payload is present it always
          // means "the importer chose the safe default".
          //
          // Capped at 64 KiB stringified to bound storage; the
          // CLI truncates with a marker on the way in if the
          // chain exceeds this.
          originalEvents: z.array(z.unknown()).max(1024),
        })
        .strict(),
    })
    .strict(),
]);

export type MemoryEvent = z.infer<typeof MemoryEventSchema>;
