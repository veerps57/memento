import { describe, expect, it } from 'vitest';
import {
  CONFLICT_EVENT_TYPES,
  CONFLICT_RESOLUTIONS,
  ConflictEventSchema,
  ConflictSchema,
} from '../src/conflict.js';

const NEW_MEMORY = '01HZX7K8Y1Z2N3Q4R5S6T7V8W9' as const;
const OTHER_MEMORY = '01HZX7K8Y1Z2N3Q4R5S6T7V8WA' as const;
const CONFLICT_ID = '01HZX7K8Y1Z2N3Q4R5S6T7V8WB' as const;
const EVENT_ID = '01HZX7K8Y1Z2N3Q4R5S6T7V8WC' as const;
const T0 = '2025-01-01T00:00:00.000Z';
const T1 = '2025-01-01T00:00:01.000Z';

const cliActor = { type: 'cli' as const };

const openConflict = {
  id: CONFLICT_ID,
  newMemoryId: NEW_MEMORY,
  conflictingMemoryId: OTHER_MEMORY,
  kind: 'fact' as const,
  evidence: { overlap: 0.92 },
  openedAt: T0,
  resolvedAt: null,
  resolution: null,
};

describe('ConflictSchema', () => {
  it('accepts an open conflict', () => {
    expect(ConflictSchema.parse(openConflict)).toEqual(openConflict);
  });

  it('accepts a resolved conflict', () => {
    const resolved = {
      ...openConflict,
      resolvedAt: T1,
      resolution: 'accept-new' as const,
    };
    expect(ConflictSchema.parse(resolved)).toEqual(resolved);
  });

  it('rejects evidence === undefined', () => {
    expect(() => ConflictSchema.parse({ ...openConflict, evidence: undefined })).toThrow();
  });

  it('accepts evidence === null', () => {
    expect(ConflictSchema.parse({ ...openConflict, evidence: null }).evidence).toBeNull();
  });

  it('rejects a memory conflicting with itself', () => {
    expect(() =>
      ConflictSchema.parse({
        ...openConflict,
        conflictingMemoryId: NEW_MEMORY,
      }),
    ).toThrow();
  });

  it('rejects resolvedAt set without resolution', () => {
    expect(() => ConflictSchema.parse({ ...openConflict, resolvedAt: T1 })).toThrow();
  });

  it('rejects resolution set without resolvedAt', () => {
    expect(() =>
      ConflictSchema.parse({
        ...openConflict,
        resolution: 'ignore' as const,
      }),
    ).toThrow();
  });

  it('rejects resolvedAt before openedAt', () => {
    expect(() =>
      ConflictSchema.parse({
        ...openConflict,
        resolvedAt: '2024-12-31T23:59:59.000Z',
        resolution: 'accept-existing' as const,
      }),
    ).toThrow();
  });

  it('rejects unknown kind', () => {
    expect(() => ConflictSchema.parse({ ...openConflict, kind: 'lesson' })).toThrow();
  });

  it('rejects unknown extra properties', () => {
    expect(() => ConflictSchema.parse({ ...openConflict, extra: true })).toThrow();
  });

  it('exposes the documented resolution choices', () => {
    expect(CONFLICT_RESOLUTIONS).toEqual(['accept-new', 'accept-existing', 'supersede', 'ignore']);
  });
});

describe('ConflictEventSchema', () => {
  const openedEvent = {
    id: EVENT_ID,
    conflictId: CONFLICT_ID,
    at: T0,
    actor: cliActor,
    type: 'opened' as const,
    payload: {
      newMemoryId: NEW_MEMORY,
      conflictingMemoryId: OTHER_MEMORY,
      kind: 'preference' as const,
      evidence: { key: 'editor.tabSize' },
    },
  };

  const resolvedEvent = {
    id: EVENT_ID,
    conflictId: CONFLICT_ID,
    at: T1,
    actor: cliActor,
    type: 'resolved' as const,
    payload: { resolution: 'supersede' as const },
  };

  it('accepts an opened event', () => {
    expect(ConflictEventSchema.parse(openedEvent)).toEqual(openedEvent);
  });

  it('accepts a resolved event', () => {
    expect(ConflictEventSchema.parse(resolvedEvent)).toEqual(resolvedEvent);
  });

  it('rejects opened payload referencing the same memory twice', () => {
    expect(() =>
      ConflictEventSchema.parse({
        ...openedEvent,
        payload: { ...openedEvent.payload, conflictingMemoryId: NEW_MEMORY },
      }),
    ).toThrow();
  });

  it('rejects an opened event with a resolved-shaped payload', () => {
    expect(() =>
      ConflictEventSchema.parse({
        ...openedEvent,
        payload: { resolution: 'ignore' },
      }),
    ).toThrow();
  });

  it('rejects a resolved event missing resolution', () => {
    expect(() => ConflictEventSchema.parse({ ...resolvedEvent, payload: {} })).toThrow();
  });

  it('rejects an unknown event type', () => {
    expect(() => ConflictEventSchema.parse({ ...openedEvent, type: 'reopened' })).toThrow();
  });

  it('rejects unknown extra properties on the envelope', () => {
    expect(() => ConflictEventSchema.parse({ ...resolvedEvent, extra: true })).toThrow();
  });

  it('exposes the closed event-type set', () => {
    expect(CONFLICT_EVENT_TYPES).toEqual(['opened', 'resolved']);
  });
});
