import { describe, expect, it } from 'vitest';
import {
  MEMORY_EVENT_TYPES,
  MemoryEventSchema,
  type MemoryEventType,
  ScrubReportSchema,
} from '../src/event.js';
import { assertNever } from '../src/scope.js';

const baseEvent = (overrides: Record<string, unknown> = {}) => ({
  id: '01J5ZK3W4Q9HVRBX1Z2Y3M4N5P',
  memoryId: '01J5ZK3W4Q9HVRBX1Z2Y3M4N5Q',
  at: '2024-01-01T00:00:00.000Z',
  actor: { type: 'cli' as const },
  scrubReport: null,
  ...overrides,
});

describe('ScrubReportSchema', () => {
  it('accepts a well-formed report', () => {
    const r = {
      rules: [{ ruleId: 'aws-key', matches: 2, severity: 'high' as const }],
      byteOffsets: [[0, 20] as [number, number], [50, 70] as [number, number]],
    };
    expect(ScrubReportSchema.parse(r)).toEqual(r);
  });

  it('rejects rules with zero matches', () => {
    expect(() =>
      ScrubReportSchema.parse({
        rules: [{ ruleId: 'r', matches: 0, severity: 'low' }],
        byteOffsets: [],
      }),
    ).toThrow();
  });

  it('rejects byte-offset pairs where end <= start', () => {
    expect(() => ScrubReportSchema.parse({ rules: [], byteOffsets: [[5, 5]] })).toThrow();
    expect(() => ScrubReportSchema.parse({ rules: [], byteOffsets: [[10, 3]] })).toThrow();
  });

  it('rejects unknown severities', () => {
    expect(() =>
      ScrubReportSchema.parse({
        rules: [{ ruleId: 'r', matches: 1, severity: 'critical' }],
        byteOffsets: [],
      } as unknown),
    ).toThrow();
  });
});

describe('MemoryEventSchema', () => {
  it('accepts a created event with empty payload', () => {
    const e = baseEvent({ type: 'created', payload: {} });
    expect(MemoryEventSchema.parse(e)).toEqual(e);
  });

  it('accepts a superseded event with a replacement id', () => {
    const e = baseEvent({
      type: 'superseded',
      payload: { replacementId: '01J5ZK3W4Q9HVRBX1Z2Y3M4N5R' },
    });
    expect(MemoryEventSchema.parse(e)).toBeDefined();
  });

  it('rejects superseded events without a replacement id', () => {
    expect(() => MemoryEventSchema.parse(baseEvent({ type: 'superseded', payload: {} }))).toThrow();
  });

  it('rejects updated events with empty patches', () => {
    expect(() => MemoryEventSchema.parse(baseEvent({ type: 'updated', payload: {} }))).toThrow();
  });

  it('accepts updated events with a single field change', () => {
    expect(
      MemoryEventSchema.parse(baseEvent({ type: 'updated', payload: { pinned: true } })),
    ).toBeDefined();
    expect(
      MemoryEventSchema.parse(baseEvent({ type: 'updated', payload: { tags: ['rust'] } })),
    ).toBeDefined();
  });

  it('accepts a forgotten event with a null reason', () => {
    expect(
      MemoryEventSchema.parse(baseEvent({ type: 'forgotten', payload: { reason: null } })),
    ).toBeDefined();
  });

  it('accepts a reembedded event with model + dimension', () => {
    expect(
      MemoryEventSchema.parse(
        baseEvent({
          type: 'reembedded',
          payload: { model: 'bge-small-en-v1.5', dimension: 384 },
        }),
      ),
    ).toBeDefined();
  });

  it('rejects unknown event types', () => {
    expect(() =>
      MemoryEventSchema.parse(
        baseEvent({ type: 'deleted', payload: {} } as unknown as Record<string, unknown>),
      ),
    ).toThrow();
  });

  it('rejects extra top-level fields', () => {
    expect(() =>
      MemoryEventSchema.parse(
        baseEvent({
          type: 'created',
          payload: {},
          extra: true,
        } as unknown as Record<string, unknown>),
      ),
    ).toThrow();
  });

  it('attaches a scrub report when provided', () => {
    const e = baseEvent({
      type: 'created',
      payload: {},
      scrubReport: {
        rules: [{ ruleId: 'jwt', matches: 1, severity: 'medium' as const }],
        byteOffsets: [[0, 100]],
      },
    });
    expect(MemoryEventSchema.parse(e)).toBeDefined();
  });

  it('MEMORY_EVENT_TYPES is exhaustive at compile time', () => {
    const visit = (t: MemoryEventType): string => {
      switch (t) {
        case 'created':
        case 'confirmed':
        case 'updated':
        case 'superseded':
        case 'forgotten':
        case 'restored':
        case 'archived':
        case 'reembedded':
          return t;
        default:
          return assertNever(t);
      }
    };
    for (const t of MEMORY_EVENT_TYPES) expect(visit(t)).toBe(t);
  });
});
