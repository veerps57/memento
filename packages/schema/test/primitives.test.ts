import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AbsolutePathSchema,
  EventIdSchema,
  MemoryIdSchema,
  NonReservedTagSchema,
  RESERVED_TAG_PREFIXES,
  RepoRemoteSchema,
  SessionIdSchema,
  TagSchema,
  TimestampSchema,
  isReservedTag,
} from '../src/primitives.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ulidArbitrary = fc
  .array(fc.integer({ min: 0, max: ULID_ALPHABET.length - 1 }), {
    minLength: 26,
    maxLength: 26,
  })
  .map((indices) => indices.map((i) => ULID_ALPHABET[i]).join(''));

const isoTimestampArbitrary = fc
  .date({
    min: new Date('1970-01-01T00:00:00.000Z'),
    max: new Date('9999-12-31T23:59:59.999Z'),
  })
  .map((d) => d.toISOString());

describe('MemoryIdSchema', () => {
  it('accepts canonical ULIDs', () => {
    fc.assert(
      fc.property(ulidArbitrary, (ulid) => {
        expect(MemoryIdSchema.parse(ulid)).toBe(ulid);
      }),
    );
  });

  it('rejects strings that are not 26 chars', () => {
    expect(() => MemoryIdSchema.parse('TOOSHORT')).toThrow();
    expect(() => MemoryIdSchema.parse(`${'A'.repeat(27)}`)).toThrow();
  });

  it('rejects ULIDs containing forbidden Crockford letters', () => {
    expect(() => MemoryIdSchema.parse('I'.repeat(26))).toThrow();
    expect(() => MemoryIdSchema.parse('L'.repeat(26))).toThrow();
    expect(() => MemoryIdSchema.parse('O'.repeat(26))).toThrow();
    expect(() => MemoryIdSchema.parse('U'.repeat(26))).toThrow();
  });
});

describe('EventIdSchema and SessionIdSchema', () => {
  it('accept the same ULID shape as MemoryIdSchema', () => {
    fc.assert(
      fc.property(ulidArbitrary, (ulid) => {
        expect(EventIdSchema.parse(ulid)).toBe(ulid);
        expect(SessionIdSchema.parse(ulid)).toBe(ulid);
      }),
    );
  });
});

describe('TimestampSchema', () => {
  it('accepts ISO-8601 UTC timestamps with millisecond precision', () => {
    fc.assert(
      fc.property(isoTimestampArbitrary, (iso) => {
        expect(TimestampSchema.parse(iso)).toBe(iso);
      }),
    );
  });

  it('rejects non-Z timezones and non-millisecond precision', () => {
    expect(() => TimestampSchema.parse('2024-01-01T00:00:00+00:00')).toThrow();
    expect(() => TimestampSchema.parse('2024-01-01T00:00:00Z')).toThrow();
    expect(() => TimestampSchema.parse('2024-01-01T00:00:00.123456Z')).toThrow();
  });
});

describe('TagSchema', () => {
  it('normalises tags by trimming and lowercasing', () => {
    expect(TagSchema.parse('  Foo  ')).toBe('foo');
    expect(TagSchema.parse('BAR')).toBe('bar');
  });

  it('accepts allowed punctuation', () => {
    for (const value of ['rust', 'team/backend', 'kind:fact', 'v1.2', 'foo-bar', 'foo_bar']) {
      expect(TagSchema.parse(value)).toBe(value);
    }
  });

  it('rejects empty, whitespace-only, or oversized tags', () => {
    expect(() => TagSchema.parse('')).toThrow();
    expect(() => TagSchema.parse('   ')).toThrow();
    expect(() => TagSchema.parse('a'.repeat(65))).toThrow();
  });

  it('rejects embedded whitespace and forbidden characters', () => {
    expect(() => TagSchema.parse('foo bar')).toThrow();
    expect(() => TagSchema.parse('foo!bar')).toThrow();
    expect(() => TagSchema.parse('-leading-dash')).toThrow();
  });
});

describe('AbsolutePathSchema', () => {
  it('accepts POSIX absolute paths', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9._-]+$/), {
          minLength: 1,
          maxLength: 6,
        }),
        (segments) => {
          const path = `/${segments.join('/')}`;
          expect(AbsolutePathSchema.parse(path)).toBe(path);
        },
      ),
    );
  });

  it('accepts Windows drive paths', () => {
    expect(AbsolutePathSchema.parse('C:\\Users\\me')).toBe('C:\\Users\\me');
    expect(AbsolutePathSchema.parse('D:/repos/memento')).toBe('D:/repos/memento');
  });

  it('rejects relative paths and bare drive letters', () => {
    expect(() => AbsolutePathSchema.parse('relative/path')).toThrow();
    expect(() => AbsolutePathSchema.parse('./relative')).toThrow();
    expect(() => AbsolutePathSchema.parse('C:')).toThrow();
    expect(() => AbsolutePathSchema.parse('')).toThrow();
  });
});

describe('RepoRemoteSchema', () => {
  it('accepts canonical host/owner/name triples', () => {
    expect(RepoRemoteSchema.parse('github.com/acme/widgets')).toBe('github.com/acme/widgets');
    expect(RepoRemoteSchema.parse('gitlab.example.com/team/repo')).toBe(
      'gitlab.example.com/team/repo',
    );
  });

  it('rejects raw git URLs and uppercase characters', () => {
    expect(() => RepoRemoteSchema.parse('git@github.com:acme/widgets.git')).toThrow();
    expect(() => RepoRemoteSchema.parse('https://github.com/acme/widgets')).toThrow();
    expect(() => RepoRemoteSchema.parse('GitHub.com/acme/widgets')).toThrow();
    expect(() => RepoRemoteSchema.parse('github.com/acme')).toThrow();
  });
});

describe('reserved tag prefixes', () => {
  it('RESERVED_TAG_PREFIXES contains the pack provenance prefix', () => {
    expect(RESERVED_TAG_PREFIXES).toContain('pack:');
  });

  it('isReservedTag detects reserved-prefix tags', () => {
    expect(isReservedTag('pack:rust-axum:1.0.0')).toBe(true);
    expect(isReservedTag('pack:foo')).toBe(true);
    expect(isReservedTag('rust')).toBe(false);
    expect(isReservedTag('source:extracted')).toBe(false);
    expect(isReservedTag('packs')).toBe(false);
  });

  it('NonReservedTagSchema accepts ordinary tags', () => {
    expect(NonReservedTagSchema.parse('rust')).toBe('rust');
    expect(NonReservedTagSchema.parse('source:extracted')).toBe('source:extracted');
    expect(NonReservedTagSchema.parse('Project:Memento')).toBe('project:memento');
  });

  it('NonReservedTagSchema rejects reserved-prefix tags', () => {
    expect(() => NonReservedTagSchema.parse('pack:rust-axum:1.0.0')).toThrow();
    expect(() => NonReservedTagSchema.parse('pack:foo')).toThrow();
  });
});
