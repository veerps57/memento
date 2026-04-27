import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from '../../src/retrieval/fts.js';

describe('sanitizeFtsQuery', () => {
  it('returns empty string when no tokens survive', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('"":()*^')).toBe('');
  });

  it('wraps tokens in quotes and joins with OR', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" OR "world"');
  });

  it('strips FTS5 sigils and tokenises on whitespace', () => {
    expect(sanitizeFtsQuery('foo:bar "baz"  qux*')).toBe('"foo" OR "bar" OR "baz" OR "qux"');
    expect(sanitizeFtsQuery('NEAR(a b)')).toBe('"NEAR" OR "a" OR "b"');
  });
});
