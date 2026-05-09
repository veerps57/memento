import {
  type Memory,
  PACK_FORMAT_VERSION,
  type PackId,
  PackIdSchema,
  type PackVersion,
  PackVersionSchema,
} from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';

import { buildManifestFromMemories } from '../../src/packs/export.js';
import { parsePackManifest } from '../../src/packs/parse.js';

const fixedTs = '2025-01-01T00:00:00.000Z';

const baseMemory = (overrides: Partial<Memory> = {}): Memory => ({
  id: '01J5ZK3W4Q9HVRBX1Z2Y3M4N5P' as never,
  createdAt: fixedTs as never,
  schemaVersion: 1,
  scope: { type: 'global' },
  owner: { type: 'local', id: 'self' },
  kind: { type: 'fact' },
  tags: [],
  pinned: false,
  content: 'something to remember',
  summary: null,
  status: 'active',
  storedConfidence: 1,
  lastConfirmedAt: fixedTs as never,
  supersedes: null,
  supersededBy: null,
  embedding: null,
  sensitive: false,
  ...overrides,
});

const baseMetadata = {
  packId: PackIdSchema.parse('test-pack') as PackId,
  version: PackVersionSchema.parse('1.0.0') as PackVersion,
  title: 'Test pack',
};

describe('buildManifestFromMemories', () => {
  it('builds a valid manifest with one memory', () => {
    const result = buildManifestFromMemories([baseMemory()], baseMetadata);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exported).toBe(1);
    expect(result.value.manifest.format).toBe(PACK_FORMAT_VERSION);
    expect(result.value.manifest.id).toBe('test-pack');
    expect(result.value.manifest.memories[0]?.kind).toBe('fact');
    expect(result.value.warnings).toEqual([]);
  });

  it('returns EMPTY error when no memories are supplied', () => {
    const result = buildManifestFromMemories([], baseMetadata);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('EMPTY');
  });

  it('returns MULTI_SCOPE when memories span more than one scope', () => {
    const result = buildManifestFromMemories(
      [
        baseMemory({ scope: { type: 'global' } }),
        baseMemory({
          id: '01J5ZK3W4Q9HVRBX1Z2Y3M4N6Q' as never,
          scope: { type: 'workspace', path: '/repo/x' as never },
        }),
      ],
      baseMetadata,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('MULTI_SCOPE');
    if (result.error.kind === 'MULTI_SCOPE') {
      expect(result.error.scopeCount).toBe(2);
    }
  });

  it('strips reserved-prefix tags and warns', () => {
    const result = buildManifestFromMemories(
      [
        baseMemory({
          tags: ['rust', 'pack:other:0.1.0'] as never,
        }),
      ],
      baseMetadata,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.memories[0]?.tags).toEqual(['rust']);
    expect(result.value.warnings.join('\n')).toMatch(/stripped 1/);
  });

  it('omits empty tag arrays from per-item output', () => {
    const result = buildManifestFromMemories([baseMemory({ tags: [] })], baseMetadata);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.memories[0]).not.toHaveProperty('tags');
  });

  it('omits pinned/sensitive/summary when they match the documented defaults', () => {
    const result = buildManifestFromMemories(
      [baseMemory({ pinned: false, sensitive: false, summary: null })],
      baseMetadata,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.value.manifest.memories[0];
    expect(item).not.toHaveProperty('pinned');
    expect(item).not.toHaveProperty('sensitive');
    expect(item).not.toHaveProperty('summary');
  });

  it('preserves pinned/sensitive/summary when set to non-default values', () => {
    const result = buildManifestFromMemories(
      [baseMemory({ pinned: true, sensitive: true, summary: 'short' })],
      baseMetadata,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.value.manifest.memories[0];
    expect(item?.pinned).toBe(true);
    expect(item?.sensitive).toBe(true);
    expect(item?.summary).toBe('short');
  });

  it('preserves kind-specific fields (rationale, due, language)', () => {
    const result = buildManifestFromMemories(
      [
        baseMemory({
          kind: { type: 'decision', rationale: 'because tradeoff' },
        }),
        baseMemory({
          id: '01J5ZK3W4Q9HVRBX1Z2Y3M4N6R' as never,
          kind: { type: 'todo', due: '2025-12-01T00:00:00.000Z' as never },
        }),
        baseMemory({
          id: '01J5ZK3W4Q9HVRBX1Z2Y3M4N6S' as never,
          kind: { type: 'snippet', language: 'rust' },
        }),
      ],
      baseMetadata,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memories = result.value.manifest.memories;
    expect(memories[0]).toMatchObject({ kind: 'decision', rationale: 'because tradeoff' });
    expect(memories[1]).toMatchObject({ kind: 'todo', due: '2025-12-01T00:00:00.000Z' });
    expect(memories[2]).toMatchObject({ kind: 'snippet', language: 'rust' });
  });

  it('drops null kind-specific fields rather than serialising them', () => {
    const result = buildManifestFromMemories(
      [baseMemory({ kind: { type: 'decision', rationale: null } })],
      baseMetadata,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.memories[0]).not.toHaveProperty('rationale');
  });

  it('threads optional metadata fields through to the manifest', () => {
    const result = buildManifestFromMemories([baseMemory()], {
      ...baseMetadata,
      description: 'A test pack',
      author: 'github.com/x',
      license: 'CC0-1.0',
      homepage: 'https://example.com/pack',
      tags: ['rust', 'web'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.description).toBe('A test pack');
    expect(result.value.manifest.author).toBe('github.com/x');
    expect(result.value.manifest.license).toBe('CC0-1.0');
    expect(result.value.manifest.homepage).toBe('https://example.com/pack');
    expect(result.value.manifest.tags).toEqual(['rust', 'web']);
  });

  it('returns INVALID_MANIFEST when metadata trips PackManifestSchema validation', () => {
    const result = buildManifestFromMemories([baseMemory()], {
      ...baseMetadata,
      homepage: 'not a url',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('INVALID_MANIFEST');
  });

  it('produces YAML that round-trips through `parsePackManifest`', () => {
    const result = buildManifestFromMemories(
      [
        baseMemory({
          tags: ['rust'] as never,
          kind: { type: 'snippet', language: 'rust' },
          content: 'fn main() {\n  println!("hi");\n}\n',
        }),
      ],
      { ...baseMetadata, description: 'Round trip' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parsePackManifest(result.value.yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.id).toBe('test-pack');
    expect(parsed.manifest.memories[0]).toMatchObject({
      kind: 'snippet',
      language: 'rust',
      content: 'fn main() {\n  println!("hi");\n}\n',
    });
  });

  it('emits YAML with literal-block scalars for multi-line content', () => {
    const result = buildManifestFromMemories(
      [baseMemory({ content: 'line one\nline two\nline three\n' })],
      baseMetadata,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.yaml).toMatch(/content: \|/);
  });
});
