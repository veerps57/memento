import { describe, expect, it } from 'vitest';
import { ScrubberRuleSchema, ScrubberRuleSetSchema } from '../src/scrubber.js';

const validRule = {
  id: 'aws-access-key',
  description: 'AWS access key prefix',
  pattern: 'AKIA[0-9A-Z]{16}',
  flags: 'i',
  placeholder: '<aws-access-key:{{rule.id}}>',
  severity: 'high' as const,
};

describe('ScrubberRuleSchema', () => {
  it('accepts a fully-specified rule', () => {
    expect(ScrubberRuleSchema.parse(validRule)).toEqual(validRule);
  });

  it('accepts a rule without flags', () => {
    const { flags: _flags, ...rest } = validRule;
    expect(ScrubberRuleSchema.parse(rest)).toEqual(rest);
  });

  it('rejects empty pattern', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, pattern: '' })).toThrow();
  });

  it('rejects an unparseable regex', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, pattern: '([' })).toThrow();
  });

  it.each(['g', 'y', 'gi', 'iy'])('rejects engine-reserved flag %s', (flags) => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, flags })).toThrow();
  });

  it('rejects repeated flag characters', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, flags: 'ii' })).toThrow();
  });

  it('rejects an empty placeholder', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, placeholder: '' })).toThrow();
  });

  it('rejects an unbalanced placeholder template', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, placeholder: '<{{rule.id>' })).toThrow();
  });

  it('accepts the documented {{rule.id}} / {{match.index}} substitutions', () => {
    const rule = {
      ...validRule,
      placeholder: '<scrubbed:{{rule.id}}@{{match.index}}>',
    };
    expect(ScrubberRuleSchema.parse(rule).placeholder).toBe(rule.placeholder);
  });

  it('accepts a literal {{{{ escape', () => {
    const rule = { ...validRule, placeholder: '{{{{not-a-substitution}}}}' };
    expect(ScrubberRuleSchema.parse(rule).placeholder).toBe(rule.placeholder);
  });

  it('rejects an id with uppercase characters', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, id: 'AWS-ACCESS-KEY' })).toThrow();
  });

  it('rejects an unknown severity', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, severity: 'critical' })).toThrow();
  });

  it('rejects unknown extra properties', () => {
    expect(() => ScrubberRuleSchema.parse({ ...validRule, extra: true })).toThrow();
  });
});

describe('ScrubberRuleSetSchema', () => {
  it('accepts an empty rule set', () => {
    expect(ScrubberRuleSetSchema.parse([])).toEqual([]);
  });

  it('preserves rule order', () => {
    const second = { ...validRule, id: 'jwt', pattern: 'eyJ[A-Za-z0-9_.-]+' };
    const parsed = ScrubberRuleSetSchema.parse([validRule, second]);
    expect(parsed.map((r) => r.id)).toEqual(['aws-access-key', 'jwt']);
  });

  it('rejects duplicate ids', () => {
    expect(() => ScrubberRuleSetSchema.parse([validRule, { ...validRule }])).toThrow();
  });
});
