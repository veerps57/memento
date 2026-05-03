import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SCOPE_TYPES, type Scope, ScopeSchema, assertNever } from '../src/scope.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () =>
  fc
    .array(fc.integer({ min: 0, max: ULID_ALPHABET.length - 1 }), {
      minLength: 26,
      maxLength: 26,
    })
    .map((indices) => indices.map((i) => ULID_ALPHABET[i]).join(''));

describe('ScopeSchema', () => {
  it('parses the global scope', () => {
    expect(ScopeSchema.parse({ type: 'global' })).toEqual({ type: 'global' });
  });

  it('parses workspace scopes with absolute paths', () => {
    const value = { type: 'workspace' as const, path: '/Users/me/project' };
    expect(ScopeSchema.parse(value)).toEqual(value);
  });

  it('parses repo scopes with canonical remotes', () => {
    const value = { type: 'repo' as const, remote: 'github.com/acme/widgets' };
    expect(ScopeSchema.parse(value)).toEqual(value);
  });

  it('parses branch scopes', () => {
    const value = {
      type: 'branch' as const,
      remote: 'github.com/acme/widgets',
      branch: 'main',
    };
    expect(ScopeSchema.parse(value)).toEqual(value);
  });

  it('parses session scopes with ULID ids', () => {
    fc.assert(
      fc.property(ulid(), (id) => {
        const value = { type: 'session' as const, id };
        expect(ScopeSchema.parse(value)).toEqual(value);
      }),
    );
  });

  it('rejects extra properties on global', () => {
    expect(() => ScopeSchema.parse({ type: 'global', path: '/x' } as unknown)).toThrow();
  });

  it('rejects workspace scopes with relative paths', () => {
    expect(() =>
      ScopeSchema.parse({
        type: 'workspace',
        path: 'relative/path',
      } as unknown),
    ).toThrow();
  });

  it('rejects repo scopes with raw git URLs', () => {
    expect(() =>
      ScopeSchema.parse({
        type: 'repo',
        remote: 'git@github.com:acme/widgets.git',
      } as unknown),
    ).toThrow();
  });

  it('rejects branch scopes with empty branch names', () => {
    expect(() =>
      ScopeSchema.parse({
        type: 'branch',
        remote: 'github.com/acme/widgets',
        branch: '',
      } as unknown),
    ).toThrow();
  });

  it('rejects unknown scope types', () => {
    expect(() => ScopeSchema.parse({ type: 'team' } as unknown)).toThrow();
  });

  // a session id that fails the ULID regex
  // used to surface as a bare "Invalid". The error must now carry
  // enough context for an AI assistant to fix its input shape on the
  // first try.
  it('rejects malformed session ids with a helpful, ULID-formatted error', () => {
    const result = ScopeSchema.safeParse({ type: 'session', id: 'not-a-ulid' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message).join(' | ');
    expect(messages).toMatch(/26-character/iu);
    expect(messages).toMatch(/Crockford|ULID/iu);
  });
});

describe('SCOPE_TYPES', () => {
  it('lists all five scope discriminators in layering order', () => {
    expect(SCOPE_TYPES).toEqual(['session', 'branch', 'repo', 'workspace', 'global']);
  });

  it('covers every variant of Scope (compile-time exhaustiveness)', () => {
    // If a new scope variant is added without updating SCOPE_TYPES,
    // the `assertNever` call below becomes a type error and this
    // test fails at compile time. The runtime body is also a guard.
    const visit = (scope: Scope): string => {
      switch (scope.type) {
        case 'global':
          return 'global';
        case 'workspace':
          return scope.path;
        case 'repo':
          return scope.remote;
        case 'branch':
          return `${scope.remote}@${scope.branch}`;
        case 'session':
          return scope.id;
        default:
          return assertNever(scope);
      }
    };

    expect(visit({ type: 'global' })).toBe('global');
    expect(visit({ type: 'workspace', path: '/x' as never })).toBe('/x');
  });
});

describe('assertNever', () => {
  it('throws when called at runtime with any value', () => {
    expect(() => assertNever('unexpected' as never)).toThrow(/unexpected value/);
  });
});
