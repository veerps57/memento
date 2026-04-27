import { z } from 'zod';
import { ActorRefSchema } from './actors.js';
import { MEMORY_KIND_TYPES } from './memory.js';
import { ConflictIdSchema, EventIdSchema, MemoryIdSchema, TimestampSchema } from './primitives.js';

/**
 * Conflict detection (see
 * [`docs/architecture/conflict-detection.md`](../../../docs/architecture/conflict-detection.md))
 * runs asynchronously after each write and emits two kinds of
 * append-only events:
 *
 * - `opened`    — the detector found a contradiction between a
 *                 freshly-written memory and an existing one.
 * - `resolved`  — a user or agent picked a resolution.
 *
 * Conflicts are modelled as their own entity rather than folded
 * into `MemoryEvent` because they are *observations about pairs of
 * memories*, with their own lifecycle, indexing, and retention.
 *
 * `Conflict` is the current-state row that makes "list open
 * conflicts" a cheap read; the events drive its lifecycle. The two
 * MUST agree by construction:
 *
 * - `resolvedAt` and `resolution` move together: both null while the
 *   conflict is open, both set once a `resolved` event is recorded.
 * - For every Conflict there is exactly one `opened` event with
 *   `at === openedAt`, and at most one `resolved` event with
 *   `at === resolvedAt`. Repository code enforces those joins; the
 *   schema enforces the field-shape invariants.
 */
export const CONFLICT_RESOLUTIONS = [
  'accept-new',
  'accept-existing',
  'supersede',
  'ignore',
] as const;
export const ConflictResolutionSchema = z.enum(CONFLICT_RESOLUTIONS);
export type ConflictResolution = z.infer<typeof ConflictResolutionSchema>;

const MemoryKindTypeSchema = z.enum(MEMORY_KIND_TYPES);

/**
 * `evidence` is opaque at this layer. Per-kind conflict policies
 * (in `@psraghuveer/memento-core`) define the concrete shape they emit. The
 * schema keeps it as `unknown`-but-defined so the loader cannot
 * silently store `undefined`, while leaving the policy free to
 * tighten the shape as needed.
 */
const EvidenceSchema = z.unknown().refine((v) => v !== undefined, {
  message: 'conflict evidence must be defined (use null for absent payloads)',
});

export const ConflictSchema = z
  .object({
    id: ConflictIdSchema,
    newMemoryId: MemoryIdSchema,
    conflictingMemoryId: MemoryIdSchema,
    kind: MemoryKindTypeSchema,
    evidence: EvidenceSchema,
    openedAt: TimestampSchema,
    resolvedAt: TimestampSchema.nullable(),
    resolution: ConflictResolutionSchema.nullable(),
  })
  .strict()
  .refine((c) => c.newMemoryId !== c.conflictingMemoryId, {
    message: 'a memory cannot conflict with itself',
  })
  .refine((c) => (c.resolvedAt === null) === (c.resolution === null), {
    message: 'resolvedAt and resolution must both be null (open) or both be set (resolved)',
  })
  .refine((c) => c.resolvedAt === null || c.resolvedAt >= c.openedAt, {
    message: 'resolvedAt must be at or after openedAt',
  });

export type Conflict = z.infer<typeof ConflictSchema>;

/**
 * `ConflictEventType` enumerates the two phases of a conflict's
 * lifecycle. The set is closed (no `withdrawn`, no `reopened` in
 * v1) — re-detection produces a fresh `Conflict` rather than
 * mutating an old one, which keeps the event stream replayable.
 */
export const CONFLICT_EVENT_TYPES = ['opened', 'resolved'] as const;
export type ConflictEventType = (typeof CONFLICT_EVENT_TYPES)[number];

const conflictEventBase = {
  id: EventIdSchema,
  conflictId: ConflictIdSchema,
  at: TimestampSchema,
  actor: ActorRefSchema,
};

export const ConflictEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...conflictEventBase,
      type: z.literal('opened'),
      payload: z
        .object({
          newMemoryId: MemoryIdSchema,
          conflictingMemoryId: MemoryIdSchema,
          kind: MemoryKindTypeSchema,
          evidence: EvidenceSchema,
        })
        .strict()
        .refine((p) => p.newMemoryId !== p.conflictingMemoryId, {
          message: 'a memory cannot conflict with itself',
        }),
    })
    .strict(),
  z
    .object({
      ...conflictEventBase,
      type: z.literal('resolved'),
      payload: z
        .object({
          resolution: ConflictResolutionSchema,
        })
        .strict(),
    })
    .strict(),
]);

export type ConflictEvent = z.infer<typeof ConflictEventSchema>;
