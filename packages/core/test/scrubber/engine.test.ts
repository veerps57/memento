import type { ScrubberRule } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { applyRules } from '../../src/scrubber/engine.js';

const high = (id: string, pattern: string, placeholder = '<r:{{rule.id}}>'): ScrubberRule => ({
  id,
  description: id,
  pattern,
  placeholder,
  severity: 'high',
});

describe('applyRules', () => {
  it('returns the original content and an empty report when no rule matches', () => {
    const { scrubbed, report } = applyRules('nothing to see here', [high('alpha', 'XYZ')]);
    expect(scrubbed).toBe('nothing to see here');
    expect(report).toEqual({ rules: [], byteOffsets: [] });
  });

  it('returns identity on an empty rule set', () => {
    const { scrubbed, report } = applyRules('content', []);
    expect(scrubbed).toBe('content');
    expect(report).toEqual({ rules: [], byteOffsets: [] });
  });

  it('replaces every match of a single rule and counts them', () => {
    const { scrubbed, report } = applyRules('aa middle aa', [high('a', 'aa')]);
    expect(scrubbed).toBe('<r:a> middle <r:a>');
    expect(report.rules).toEqual([{ ruleId: 'a', matches: 2, severity: 'high' }]);
    expect(report.byteOffsets).toEqual([
      [0, 2],
      [10, 12],
    ]);
  });

  it('first-match-wins: a later rule cannot match a region already claimed', () => {
    const rules: ScrubberRule[] = [
      high('outer', 'sk-[A-Za-z0-9]{6,}'),
      high('inner', '[A-Za-z0-9]{4,}'),
    ];
    const { scrubbed, report } = applyRules('token sk-ABCDEFGHIJ end', rules);
    expect(scrubbed).toContain('<r:outer>');
    // 'token' (5 chars) and 'end' (3 chars) — only 'token' is long
    // enough for the inner rule, so we still expect one inner match.
    const inner = report.rules.find((r) => r.ruleId === 'inner');
    expect(inner?.matches).toBe(1);
    // Outer fired exactly once and consumed the sk-... region.
    expect(report.rules.find((r) => r.ruleId === 'outer')?.matches).toBe(1);
  });

  it('byteOffsets are pre-scrub coordinates and sorted left-to-right', () => {
    const { report } = applyRules('AA BB AA BB', [high('a', 'AA'), high('b', 'BB')]);
    expect(report.byteOffsets).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 11],
    ]);
  });

  it('substitutes {{rule.id}} and {{match.index}} in placeholders', () => {
    const { scrubbed } = applyRules('XX YY XX', [
      { ...high('m', 'XX'), placeholder: '[{{rule.id}}#{{match.index}}]' },
    ]);
    expect(scrubbed).toBe('[m#1] YY [m#2]');
  });

  it('treats {{{{ and }}}} as literal braces in placeholders', () => {
    const { scrubbed } = applyRules('X', [
      { ...high('m', 'X'), placeholder: '{{{{{{rule.id}}}}}}' },
    ]);
    // {{{{ → {{; {{rule.id}} → m; }}}} → }}  → final: {{m}}
    expect(scrubbed).toBe('{{m}}');
  });

  it('honours user-supplied flags (case-insensitive match)', () => {
    const { report } = applyRules('Foo foo FOO', [{ ...high('case', 'foo'), flags: 'i' }]);
    expect(report.rules[0]?.matches).toBe(3);
  });

  it('does not loop forever on a zero-length-capable pattern', () => {
    // `X*` matches the empty string at every position; the engine
    // must skip past zero-length matches rather than loop.
    const { scrubbed, report } = applyRules('abc', [high('z', 'X*')]);
    expect(scrubbed).toBe('abc');
    expect(report.rules).toEqual([]);
  });
});
