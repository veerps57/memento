import { describe, expect, it } from 'vitest';
import {
  PACK_FORMAT_VERSION,
  PackIdSchema,
  PackManifestSchema,
  PackMemoryItemSchema,
  PackVersionSchema,
  formatPackTag,
  packTagPrefix,
  parsePackTag,
} from '../src/pack.js';

const validId = (raw: string) => PackIdSchema.parse(raw);
const validVersion = (raw: string) => PackVersionSchema.parse(raw);

const baseManifest = (overrides: Record<string, unknown> = {}) => ({
  format: PACK_FORMAT_VERSION,
  id: 'rust-axum',
  version: '1.0.0',
  title: 'Rust + Axum web service conventions',
  memories: [{ kind: 'fact' as const, content: 'Axum is the canonical Rust web framework here.' }],
  ...overrides,
});

describe('PackIdSchema', () => {
  it('accepts lowercase kebab-case ids 2–32 chars starting with a letter', () => {
    expect(PackIdSchema.parse('ab')).toBe('ab');
    expect(PackIdSchema.parse('rust-axum')).toBe('rust-axum');
    expect(PackIdSchema.parse('ts-monorepo-pnpm')).toBe('ts-monorepo-pnpm');
    expect(PackIdSchema.parse(`a${'a'.repeat(31)}`)).toBe(`a${'a'.repeat(31)}`);
  });

  it('rejects ids that start with a digit, hyphen, or uppercase', () => {
    expect(() => PackIdSchema.parse('1pack')).toThrow();
    expect(() => PackIdSchema.parse('-pack')).toThrow();
    expect(() => PackIdSchema.parse('Pack')).toThrow();
  });

  it('rejects ids that are too short or too long', () => {
    expect(() => PackIdSchema.parse('a')).toThrow();
    expect(() => PackIdSchema.parse(`a${'a'.repeat(32)}`)).toThrow();
  });

  it('rejects ids with disallowed characters', () => {
    expect(() => PackIdSchema.parse('rust_axum')).toThrow();
    expect(() => PackIdSchema.parse('rust.axum')).toThrow();
    expect(() => PackIdSchema.parse('rust:axum')).toThrow();
    expect(() => PackIdSchema.parse('rust@axum')).toThrow();
    expect(() => PackIdSchema.parse('rust axum')).toThrow();
  });
});

describe('PackVersionSchema', () => {
  it('accepts MAJOR.MINOR.PATCH', () => {
    expect(PackVersionSchema.parse('0.0.0')).toBe('0.0.0');
    expect(PackVersionSchema.parse('1.0.0')).toBe('1.0.0');
    expect(PackVersionSchema.parse('10.20.30')).toBe('10.20.30');
  });

  it('accepts lowercase prerelease', () => {
    expect(PackVersionSchema.parse('1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(PackVersionSchema.parse('0.1.0-alpha')).toBe('0.1.0-alpha');
    expect(PackVersionSchema.parse('1.2.3-beta.10')).toBe('1.2.3-beta.10');
  });

  it('rejects leading zeros in numeric components', () => {
    expect(() => PackVersionSchema.parse('01.0.0')).toThrow();
    expect(() => PackVersionSchema.parse('1.02.0')).toThrow();
    expect(() => PackVersionSchema.parse('1.0.03')).toThrow();
  });

  it('rejects build metadata (`+...`)', () => {
    expect(() => PackVersionSchema.parse('1.0.0+build.1')).toThrow();
    expect(() => PackVersionSchema.parse('1.0.0-rc.1+exp')).toThrow();
  });

  it('rejects uppercase prerelease', () => {
    expect(() => PackVersionSchema.parse('1.0.0-RC.1')).toThrow();
    expect(() => PackVersionSchema.parse('1.0.0-Alpha')).toThrow();
  });

  it('rejects partial or empty versions', () => {
    expect(() => PackVersionSchema.parse('')).toThrow();
    expect(() => PackVersionSchema.parse('1')).toThrow();
    expect(() => PackVersionSchema.parse('1.0')).toThrow();
  });

  it('rejects versions exceeding 24 chars', () => {
    expect(() => PackVersionSchema.parse(`1.0.0-${'a'.repeat(20)}`)).toThrow();
  });
});

describe('PackMemoryItemSchema', () => {
  it('parses each kind variant with kind-specific fields', () => {
    expect(PackMemoryItemSchema.parse({ kind: 'fact', content: 'a' })).toEqual({
      kind: 'fact',
      content: 'a',
    });
    expect(PackMemoryItemSchema.parse({ kind: 'preference', content: 'b' })).toEqual({
      kind: 'preference',
      content: 'b',
    });
    expect(
      PackMemoryItemSchema.parse({ kind: 'decision', content: 'c', rationale: 'why' }),
    ).toEqual({ kind: 'decision', content: 'c', rationale: 'why' });
    expect(PackMemoryItemSchema.parse({ kind: 'todo', content: 'd' })).toEqual({
      kind: 'todo',
      content: 'd',
    });
    expect(PackMemoryItemSchema.parse({ kind: 'snippet', content: 'e', language: 'rust' })).toEqual(
      { kind: 'snippet', content: 'e', language: 'rust' },
    );
  });

  it('rejects unknown per-item keys (catches typos like `langauge`)', () => {
    expect(() =>
      PackMemoryItemSchema.parse({ kind: 'snippet', content: 'e', langauge: 'rust' }),
    ).toThrow();
    expect(() =>
      PackMemoryItemSchema.parse({ kind: 'fact', content: 'a', rationale: 'wrong slot' }),
    ).toThrow();
  });

  it('rejects empty content', () => {
    expect(() => PackMemoryItemSchema.parse({ kind: 'fact', content: '' })).toThrow();
  });

  it('rejects reserved `pack:*` tags in user-authored memory tags', () => {
    expect(() =>
      PackMemoryItemSchema.parse({ kind: 'fact', content: 'a', tags: ['pack:foo:1.0.0'] }),
    ).toThrow();
  });

  it('accepts ordinary tags', () => {
    expect(
      PackMemoryItemSchema.parse({ kind: 'fact', content: 'a', tags: ['rust', 'auth'] }),
    ).toMatchObject({ tags: ['rust', 'auth'] });
  });

  it('rejects unknown kind', () => {
    expect(() => PackMemoryItemSchema.parse({ kind: 'episode', content: 'a' })).toThrow();
  });
});

describe('PackManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    const parsed = PackManifestSchema.parse(baseManifest());
    expect(parsed.format).toBe(PACK_FORMAT_VERSION);
    expect(parsed.id).toBe('rust-axum');
    expect(parsed.memories).toHaveLength(1);
  });

  it('rejects unknown top-level keys (caught by parser layer for warnings, but schema is strict)', () => {
    expect(() =>
      PackManifestSchema.parse({ ...baseManifest(), unknownTopLevel: 'oops' }),
    ).toThrow();
  });

  it('rejects an empty memories array', () => {
    expect(() => PackManifestSchema.parse(baseManifest({ memories: [] }))).toThrow();
  });

  it('rejects a wrong format literal', () => {
    expect(() => PackManifestSchema.parse(baseManifest({ format: 'memento-pack/v0' }))).toThrow();
    expect(() => PackManifestSchema.parse(baseManifest({ format: 'memento-pack/v2' }))).toThrow();
  });

  it('rejects reserved `pack:*` tags at the manifest level', () => {
    expect(() => PackManifestSchema.parse(baseManifest({ tags: ['pack:foo:1.0.0'] }))).toThrow();
  });

  it('rejects reserved `pack:*` tags inside `defaults.tags`', () => {
    expect(() =>
      PackManifestSchema.parse(baseManifest({ defaults: { tags: ['pack:foo:1.0.0'] } })),
    ).toThrow();
  });

  it('accepts an `https://` homepage URL', () => {
    const parsed = PackManifestSchema.parse(baseManifest({ homepage: 'https://example.com/pack' }));
    expect(parsed.homepage).toBe('https://example.com/pack');
  });

  it('rejects a homepage that is not a URL', () => {
    expect(() => PackManifestSchema.parse(baseManifest({ homepage: 'not a url' }))).toThrow();
  });

  it('accepts pack-discovery `tags` and rejects more than 20 of them', () => {
    expect(PackManifestSchema.parse(baseManifest({ tags: ['rust', 'web'] })).tags).toEqual([
      'rust',
      'web',
    ]);
    expect(() =>
      PackManifestSchema.parse(
        baseManifest({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
      ),
    ).toThrow();
  });
});

describe('formatPackTag / parsePackTag', () => {
  it('round-trips a valid id+version', () => {
    const id = validId('rust-axum');
    const version = validVersion('1.2.0');
    const tag = formatPackTag(id, version);
    expect(tag).toBe('pack:rust-axum:1.2.0');
    expect(parsePackTag(tag)).toEqual({ id: 'rust-axum', version: '1.2.0' });
  });

  it('round-trips with a prerelease version', () => {
    const id = validId('ts-monorepo-pnpm');
    const version = validVersion('0.1.0-rc.1');
    const tag = formatPackTag(id, version);
    expect(tag).toBe('pack:ts-monorepo-pnpm:0.1.0-rc.1');
    expect(parsePackTag(tag)).toEqual({ id: 'ts-monorepo-pnpm', version: '0.1.0-rc.1' });
  });

  it('parsePackTag returns null for non-pack tags', () => {
    expect(parsePackTag('rust')).toBeNull();
    expect(parsePackTag('source:extracted')).toBeNull();
    expect(parsePackTag('pack:no-version')).toBeNull();
    expect(parsePackTag('pack:bad-version:not-semver')).toBeNull();
    expect(parsePackTag('pack::1.0.0')).toBeNull();
  });

  it('parsePackTag rejects malformed versions inside an otherwise pack-shaped tag', () => {
    expect(parsePackTag('pack:rust-axum:1.0.0+build')).toBeNull();
    expect(parsePackTag('pack:rust-axum:1.0')).toBeNull();
  });
});

describe('packTagPrefix', () => {
  it('returns `pack:<id>:` for use as a tag-prefix filter', () => {
    expect(packTagPrefix(validId('rust-axum'))).toBe('pack:rust-axum:');
  });
});
