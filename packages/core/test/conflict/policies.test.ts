import type { Memory, MemoryId } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_POLICIES,
  DEFAULT_POLICY_CONFIG,
  runPolicy,
} from '../../src/conflict/policies.js';

const MEMORY_KIND_TYPES = ['fact', 'preference', 'decision', 'todo', 'snippet'] as const;

const NOW = '2026-01-01T00:00:00.000Z';

function memory(overrides: Partial<Omit<Memory, 'id'>> & { id: string; content: string }): Memory {
  const base = {
    id: overrides.id as unknown as MemoryId,
    createdAt: NOW,
    schemaVersion: 1,
    scope: { type: 'global' },
    owner: { type: 'local', id: 'self' },
    kind: { type: 'fact' },
    tags: [],
    pinned: false,
    content: overrides.content,
    summary: null,
    status: 'active',
    storedConfidence: 1,
    lastConfirmedAt: NOW,
    supersedes: null,
    supersededBy: null,
    embedding: null,
    sensitive: false,
  };
  return { ...base, ...overrides } as Memory;
}

describe('CONFLICT_POLICIES registry', () => {
  it('is total over MemoryKindType — every kind has a policy', () => {
    for (const kind of MEMORY_KIND_TYPES) {
      expect(CONFLICT_POLICIES[kind]).toBeTypeOf('function');
    }
    expect(Object.keys(CONFLICT_POLICIES).sort()).toEqual([...MEMORY_KIND_TYPES].sort());
  });
});

describe('runPolicy short-circuits', () => {
  it('returns no-conflict when ids are equal', () => {
    const m = memory({ id: 'M1', content: 'a: x' });
    expect(runPolicy(m, m)).toEqual({ conflict: false });
  });

  it('returns no-conflict when kinds differ', () => {
    const a = memory({
      id: 'M1',
      content: 'tabs: yes',
      kind: { type: 'preference' },
    });
    const b = memory({ id: 'M2', content: 'tabs: no', kind: { type: 'fact' } });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });

  it('returns no-conflict when next supersedes candidate', () => {
    const next = memory({
      id: 'M2',
      content: 'tabs: yes',
      kind: { type: 'preference' },
      supersedes: 'M1' as Memory['supersedes'],
    });
    const cand = memory({
      id: 'M1',
      content: 'tabs: no',
      kind: { type: 'preference' },
    });
    expect(runPolicy(next, cand)).toEqual({ conflict: false });
  });
});

describe('preference policy', () => {
  it('flags same key with different values', () => {
    const a = memory({
      id: 'M1',
      content: 'tabs: yes',
      kind: { type: 'preference' },
    });
    const b = memory({
      id: 'M2',
      content: 'tabs: no',
      kind: { type: 'preference' },
    });
    const result = runPolicy(a, b);
    expect(result.conflict).toBe(true);
    if (result.conflict) {
      expect(result.evidence).toMatchObject({
        kind: 'preference',
        key: 'tabs',
      });
    }
  });

  it('accepts `=` as a separator', () => {
    const a = memory({
      id: 'M1',
      content: 'EDITOR = vim',
      kind: { type: 'preference' },
    });
    const b = memory({
      id: 'M2',
      content: 'editor=emacs',
      kind: { type: 'preference' },
    });
    expect(runPolicy(a, b).conflict).toBe(true);
  });

  it('does not flag identical preferences', () => {
    const a = memory({
      id: 'M1',
      content: 'tabs: yes',
      kind: { type: 'preference' },
    });
    const b = memory({
      id: 'M2',
      content: 'tabs: yes',
      kind: { type: 'preference' },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });

  it('does not flag different keys', () => {
    const a = memory({
      id: 'M1',
      content: 'tabs: yes',
      kind: { type: 'preference' },
    });
    const b = memory({
      id: 'M2',
      content: 'theme: dark',
      kind: { type: 'preference' },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });

  it('stays silent on unstructured preferences (no `:` or `=`)', () => {
    const a = memory({
      id: 'M1',
      content: 'I like dark mode',
      kind: { type: 'preference' },
    });
    const b = memory({
      id: 'M2',
      content: 'I like light mode',
      kind: { type: 'preference' },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });
});

describe('decision policy', () => {
  it('flags same context with different choices', () => {
    const a = memory({
      id: 'M1',
      content: 'database: postgres',
      kind: { type: 'decision', rationale: null },
    });
    const b = memory({
      id: 'M2',
      content: 'database: mysql',
      kind: { type: 'decision', rationale: 'cheaper' },
    });
    const result = runPolicy(a, b);
    expect(result.conflict).toBe(true);
    if (result.conflict) {
      expect(result.evidence).toMatchObject({
        kind: 'decision',
        context: 'database',
      });
    }
  });

  it('ignores rationale differences when the choice agrees', () => {
    const a = memory({
      id: 'M1',
      content: 'database: postgres',
      kind: { type: 'decision', rationale: 'fast' },
    });
    const b = memory({
      id: 'M2',
      content: 'database: postgres',
      kind: { type: 'decision', rationale: 'familiar' },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });
});

describe('todo policy', () => {
  it('flags same action with different due dates', () => {
    const a = memory({
      id: 'M1',
      content: 'Ship release notes',
      kind: {
        type: 'todo',
        due: '2026-02-01T00:00:00.000Z' as Memory['lastConfirmedAt'],
      },
    });
    const b = memory({
      id: 'M2',
      content: 'ship release notes',
      kind: {
        type: 'todo',
        due: '2026-03-01T00:00:00.000Z' as Memory['lastConfirmedAt'],
      },
    });
    const result = runPolicy(a, b);
    expect(result.conflict).toBe(true);
  });

  it('flags same action with set-vs-null due', () => {
    const a = memory({
      id: 'M1',
      content: 'Ship release notes',
      kind: {
        type: 'todo',
        due: '2026-02-01T00:00:00.000Z' as Memory['lastConfirmedAt'],
      },
    });
    const b = memory({
      id: 'M2',
      content: 'Ship release notes',
      kind: { type: 'todo', due: null },
    });
    expect(runPolicy(a, b).conflict).toBe(true);
  });

  it('stays silent when actions differ', () => {
    const a = memory({
      id: 'M1',
      content: 'Ship release notes',
      kind: { type: 'todo', due: null },
    });
    const b = memory({
      id: 'M2',
      content: 'Write docs',
      kind: { type: 'todo', due: null },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });
});

describe('snippet policy', () => {
  it('flags same language and same first line with different bodies', () => {
    const a = memory({
      id: 'M1',
      content: 'function add(a, b) {\n  return a + b;\n}',
      kind: { type: 'snippet', language: 'js' },
    });
    const b = memory({
      id: 'M2',
      content: 'function add(a, b) {\n  return a - b;\n}',
      kind: { type: 'snippet', language: 'js' },
    });
    expect(runPolicy(a, b).conflict).toBe(true);
  });

  it('does not flag different languages', () => {
    const a = memory({
      id: 'M1',
      content: 'function add(a, b) {}',
      kind: { type: 'snippet', language: 'js' },
    });
    const b = memory({
      id: 'M2',
      content: 'function add(a, b) {}',
      kind: { type: 'snippet', language: 'ts' },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });

  it('does not flag null language', () => {
    const a = memory({
      id: 'M1',
      content: 'fn add() {}',
      kind: { type: 'snippet', language: null },
    });
    const b = memory({
      id: 'M2',
      content: 'fn add() {}',
      kind: { type: 'snippet', language: null },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });

  it('does not flag identical snippets', () => {
    const a = memory({
      id: 'M1',
      content: 'function add() { return 1; }',
      kind: { type: 'snippet', language: 'js' },
    });
    const b = memory({
      id: 'M2',
      content: 'function add() { return 1; }',
      kind: { type: 'snippet', language: 'js' },
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });
});

describe('fact policy', () => {
  it('flags asymmetric negation with overlapping vocabulary', () => {
    const a = memory({
      id: 'M1',
      content: 'The build script uses pnpm install across packages',
    });
    const b = memory({
      id: 'M2',
      content: 'No, the build script uses pnpm install across packages',
    });
    expect(runPolicy(a, b).conflict).toBe(true);
  });

  it('stays silent when both are negated (agreement, not flip)', () => {
    const a = memory({
      id: 'M1',
      content: 'Not deploying through Helm anymore today',
    });
    const b = memory({
      id: 'M2',
      content: 'Never deploying through Helm anymore today',
    });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });

  it('stays silent below the overlap threshold', () => {
    const a = memory({ id: 'M1', content: 'cats nice' });
    const b = memory({ id: 'M2', content: 'No, cats nice' });
    expect(runPolicy(a, b)).toEqual({ conflict: false });
  });

  it('respects a custom factOverlapThreshold', () => {
    const a = memory({ id: 'M1', content: 'lorem ipsum dolor' });
    const b = memory({ id: 'M2', content: 'No lorem ipsum dolor' });
    // default threshold = 3 → exactly meets, but let's lift to 5 → silent
    expect(runPolicy(a, b, { ...DEFAULT_POLICY_CONFIG, factOverlapThreshold: 5 })).toEqual({
      conflict: false,
    });
  });
});
