import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EmbeddingSchema,
  MEMORY_KIND_TYPES,
  MEMORY_SCHEMA_VERSION,
  MEMORY_STATUSES,
  MemoryKindSchema,
  MemorySchema,
  MemoryStatusSchema,
} from '../src/memory.js';
import { assertNever } from '../src/scope.js';

const sampleMemory = (overrides: Record<string, unknown> = {}) => ({
  id: '01J5ZK3W4Q9HVRBX1Z2Y3M4N5P',
  createdAt: '2024-01-01T00:00:00.000Z',
  schemaVersion: MEMORY_SCHEMA_VERSION,
  scope: { type: 'global' as const },
  owner: { type: 'local' as const, id: 'self' },
  kind: { type: 'fact' as const },
  tags: [],
  pinned: false,
  content: 'memento mori',
  summary: null,
  status: 'active' as const,
  storedConfidence: 0.5,
  lastConfirmedAt: '2024-01-01T00:00:00.000Z',
  supersedes: null,
  supersededBy: null,
  embedding: null,
  sensitive: false,
  ...overrides,
});

describe('MemoryKindSchema', () => {
  it('accepts every known kind', () => {
    expect(MemoryKindSchema.parse({ type: 'fact' })).toEqual({ type: 'fact' });
    expect(MemoryKindSchema.parse({ type: 'preference' })).toEqual({
      type: 'preference',
    });
    expect(MemoryKindSchema.parse({ type: 'decision', rationale: null })).toEqual({
      type: 'decision',
      rationale: null,
    });
    expect(
      MemoryKindSchema.parse({
        type: 'decision',
        rationale: 'because tradeoff X',
      }),
    ).toEqual({
      type: 'decision',
      rationale: 'because tradeoff X',
    });
    expect(MemoryKindSchema.parse({ type: 'todo', due: null })).toEqual({
      type: 'todo',
      due: null,
    });
    expect(MemoryKindSchema.parse({ type: 'snippet', language: 'rust' })).toEqual({
      type: 'snippet',
      language: 'rust',
    });
  });

  it('rejects rationale on non-decision kinds', () => {
    expect(() => MemoryKindSchema.parse({ type: 'fact', rationale: 'x' } as unknown)).toThrow();
  });

  it('rejects unknown kinds', () => {
    expect(() => MemoryKindSchema.parse({ type: 'episode' } as unknown)).toThrow();
    expect(() => MemoryKindSchema.parse({ type: 'lesson' } as unknown)).toThrow();
  });

  it('MEMORY_KIND_TYPES covers every variant (compile-time)', () => {
    const visit = (kind: {
      type: (typeof MEMORY_KIND_TYPES)[number];
    }): string => {
      switch (kind.type) {
        case 'fact':
        case 'preference':
        case 'decision':
        case 'todo':
        case 'snippet':
          return kind.type;
        default:
          return assertNever(kind.type);
      }
    };
    for (const t of MEMORY_KIND_TYPES) expect(visit({ type: t })).toBe(t);
  });
});

describe('MemoryStatusSchema', () => {
  it('accepts every documented status', () => {
    for (const s of MEMORY_STATUSES) expect(MemoryStatusSchema.parse(s)).toBe(s);
  });

  it('rejects unknown statuses', () => {
    expect(() => MemoryStatusSchema.parse('deleted')).toThrow();
  });
});

describe('EmbeddingSchema', () => {
  it('accepts a well-formed embedding', () => {
    const e = {
      model: 'bge-small-en-v1.5',
      dimension: 3,
      vector: [0.1, -0.2, 0.3],
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    expect(EmbeddingSchema.parse(e)).toEqual(e);
  });

  it('rejects vectors whose length differs from the declared dimension', () => {
    expect(() =>
      EmbeddingSchema.parse({
        model: 'm',
        dimension: 4,
        vector: [0.1, 0.2, 0.3],
        createdAt: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects non-finite floats in the vector', () => {
    expect(() =>
      EmbeddingSchema.parse({
        model: 'm',
        dimension: 1,
        vector: [Number.POSITIVE_INFINITY],
        createdAt: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('MemorySchema', () => {
  it('accepts a minimal active memory', () => {
    const m = sampleMemory();
    expect(MemorySchema.parse(m)).toEqual(m);
  });

  it('rejects extra top-level properties', () => {
    expect(() => MemorySchema.parse(sampleMemory({ extra: true }))).toThrow();
  });

  it('rejects storedConfidence outside [0, 1]', () => {
    expect(() => MemorySchema.parse(sampleMemory({ storedConfidence: -0.01 }))).toThrow();
    expect(() => MemorySchema.parse(sampleMemory({ storedConfidence: 1.01 }))).toThrow();
  });

  it('property: storedConfidence ∈ [0, 1] always parses', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (c) => {
        expect(MemorySchema.parse(sampleMemory({ storedConfidence: c }))).toBeDefined();
      }),
    );
  });

  it('rejects lastConfirmedAt < createdAt', () => {
    expect(() =>
      MemorySchema.parse(
        sampleMemory({
          createdAt: '2024-06-01T00:00:00.000Z',
          lastConfirmedAt: '2024-01-01T00:00:00.000Z',
        }),
      ),
    ).toThrow();
  });

  it('rejects status=superseded without a supersededBy', () => {
    expect(() => MemorySchema.parse(sampleMemory({ status: 'superseded' }))).toThrow();
  });

  it('rejects supersededBy without status=superseded', () => {
    expect(() =>
      MemorySchema.parse(sampleMemory({ supersededBy: '01J5ZK3W4Q9HVRBX1Z2Y3M4N5Q' })),
    ).toThrow();
  });

  it('accepts a valid superseded memory', () => {
    const m = sampleMemory({
      status: 'superseded',
      supersededBy: '01J5ZK3W4Q9HVRBX1Z2Y3M4N5Q',
    });
    expect(MemorySchema.parse(m)).toBeDefined();
  });

  it('normalises tag values via TagSchema', () => {
    const m = sampleMemory({ tags: ['  Foo  ', 'BAR'] });
    const parsed = MemorySchema.parse(m);
    expect(parsed.tags).toEqual(['foo', 'bar']);
  });
});
