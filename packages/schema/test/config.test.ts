import { describe, expect, it } from 'vitest';
import {
  CONFIG_SOURCES,
  ConfigEntrySchema,
  ConfigEventSchema,
  ConfigKeySchema,
  ConfigSourceSchema,
} from '../src/config.js';

const ID = '01J5ZK3W4Q9HVRBX1Z2Y3M4N5P';
const TS = '2024-01-01T00:00:00.000Z';

describe('ConfigKeySchema', () => {
  it('accepts dotted lowercase keys', () => {
    expect(ConfigKeySchema.parse('retrieval.vector.enabled')).toBe('retrieval.vector.enabled');
    expect(ConfigKeySchema.parse('decay.halfLife.fact')).toBeDefined();
  });

  it('rejects single-segment keys', () => {
    expect(() => ConfigKeySchema.parse('retrieval')).toThrow();
  });

  it('rejects upper-case and leading-digit segments', () => {
    expect(() => ConfigKeySchema.parse('Retrieval.vector')).toThrow();
    expect(() => ConfigKeySchema.parse('1retrieval.vector')).toThrow();
  });

  it('rejects empty / whitespace / trailing dots', () => {
    expect(() => ConfigKeySchema.parse('')).toThrow();
    expect(() => ConfigKeySchema.parse('a.')).toThrow();
    expect(() => ConfigKeySchema.parse('.a.b')).toThrow();
    expect(() => ConfigKeySchema.parse('a..b')).toThrow();
  });
});

describe('ConfigSourceSchema', () => {
  it('accepts every documented source', () => {
    for (const s of CONFIG_SOURCES) expect(ConfigSourceSchema.parse(s)).toBe(s);
  });

  it('rejects unknown sources', () => {
    expect(() => ConfigSourceSchema.parse('remote')).toThrow();
  });
});

describe('ConfigEntrySchema', () => {
  it('accepts a default-sourced entry with no actor', () => {
    const e = {
      key: 'retrieval.vector.enabled',
      value: false,
      source: 'default' as const,
      setAt: TS,
      setBy: null,
    };
    expect(ConfigEntrySchema.parse(e)).toEqual(e);
  });

  it('accepts a CLI-sourced entry with an actor', () => {
    expect(
      ConfigEntrySchema.parse({
        key: 'decay.halfLife.fact',
        value: '90d',
        source: 'cli',
        setAt: TS,
        setBy: { type: 'cli' },
      }),
    ).toBeDefined();
  });

  it('rejects extra fields', () => {
    expect(() =>
      ConfigEntrySchema.parse({
        key: 'a.b',
        value: 1,
        source: 'default',
        setAt: TS,
        setBy: null,
        extra: true,
      } as unknown),
    ).toThrow();
  });
});

describe('ConfigEventSchema', () => {
  it('accepts a set event with old + new values', () => {
    expect(
      ConfigEventSchema.parse({
        id: ID,
        key: 'retrieval.ranker.weights.fts',
        oldValue: 1,
        newValue: 0.7,
        source: 'mcp',
        actor: { type: 'mcp', agent: 'claude-code' },
        at: TS,
      }),
    ).toBeDefined();
  });

  it('accepts an unset event (newValue null)', () => {
    expect(
      ConfigEventSchema.parse({
        id: ID,
        key: 'retrieval.ranker.weights.fts',
        oldValue: 0.7,
        newValue: null,
        source: 'cli',
        actor: { type: 'cli' },
        at: TS,
      }),
    ).toBeDefined();
  });

  it('accepts a first-set event (oldValue null)', () => {
    expect(
      ConfigEventSchema.parse({
        id: ID,
        key: 'scope.defaultWriteScope',
        oldValue: null,
        newValue: 'repo',
        source: 'cli',
        actor: { type: 'cli' },
        at: TS,
      }),
    ).toBeDefined();
  });

  it('rejects events missing required fields', () => {
    expect(() =>
      ConfigEventSchema.parse({
        id: ID,
        key: 'a.b',
        newValue: 1,
        source: 'cli',
        actor: { type: 'cli' },
        at: TS,
      } as unknown),
    ).toThrow();
  });
});
