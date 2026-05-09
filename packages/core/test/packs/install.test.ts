import {
  PACK_FORMAT_VERSION,
  type PackId,
  type PackManifest,
  PackManifestSchema,
  type PackVersion,
} from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';

import {
  checkInstallState,
  derivePackClientToken,
  translateManifestToWriteInputs,
} from '../../src/packs/install.js';

const baseManifest = (overrides: Record<string, unknown> = {}): PackManifest =>
  PackManifestSchema.parse({
    format: PACK_FORMAT_VERSION,
    id: 'rust-axum',
    version: '1.0.0',
    title: 'Rust + Axum',
    memories: [
      { kind: 'fact', content: 'Axum is the canonical Rust web framework here.' },
      {
        kind: 'decision',
        content: 'Auth via Axum extractors, not middleware.',
        rationale: 'Extractors compose with handler types.',
        tags: ['auth'],
      },
    ],
    ...overrides,
  });

describe('translateManifestToWriteInputs', () => {
  it('produces one write input per manifest memory, in order', () => {
    const m = baseManifest();
    const t = translateManifestToWriteInputs(m);
    expect(t.items).toHaveLength(2);
    expect(t.items[0]?.content).toBe('Axum is the canonical Rust web framework here.');
    expect(t.items[1]?.content).toBe('Auth via Axum extractors, not middleware.');
  });

  it('appends the canonical pack tag to every item', () => {
    const m = baseManifest();
    const t = translateManifestToWriteInputs(m);
    for (const item of t.items) {
      expect(item.tags).toContain('pack:rust-axum:1.0.0');
    }
  });

  it('merges manifest-level defaults.tags with item.tags and the pack tag', () => {
    const m = baseManifest({
      defaults: { tags: ['rust', 'web'] },
    });
    const t = translateManifestToWriteInputs(m);
    const second = t.items[1];
    // Order: defaults.tags, item.tags, pack tag (deduped)
    expect(second?.tags).toEqual(['rust', 'web', 'auth', 'pack:rust-axum:1.0.0']);
  });

  it('defaults scope to global when manifest and override are both absent', () => {
    const m = baseManifest();
    const t = translateManifestToWriteInputs(m);
    expect(t.scope).toEqual({ type: 'global' });
    for (const item of t.items) expect(item.scope).toEqual({ type: 'global' });
  });

  it('honours manifest defaults.scope when no override is supplied', () => {
    const m = baseManifest({
      defaults: { scope: { type: 'workspace', path: '/repo/x' } },
    });
    const t = translateManifestToWriteInputs(m);
    expect(t.scope).toEqual({ type: 'workspace', path: '/repo/x' });
  });

  it('lets scopeOverride win over manifest defaults', () => {
    const m = baseManifest({
      defaults: { scope: { type: 'workspace', path: '/repo/x' } },
    });
    const t = translateManifestToWriteInputs(m, {
      scopeOverride: { type: 'global' },
    });
    expect(t.scope).toEqual({ type: 'global' });
  });

  it('maps each kind variant to the right MemoryKind shape', () => {
    const m = PackManifestSchema.parse({
      format: PACK_FORMAT_VERSION,
      id: 'mixed',
      version: '0.1.0',
      title: 'Mixed kinds',
      memories: [
        { kind: 'fact', content: 'a' },
        { kind: 'preference', content: 'b' },
        { kind: 'decision', content: 'c', rationale: 'd' },
        { kind: 'todo', content: 'e' },
        { kind: 'snippet', content: 'f', language: 'rust' },
      ],
    });
    const t = translateManifestToWriteInputs(m);
    expect(t.items[0]?.kind).toEqual({ type: 'fact' });
    expect(t.items[1]?.kind).toEqual({ type: 'preference' });
    expect(t.items[2]?.kind).toEqual({ type: 'decision', rationale: 'd' });
    expect(t.items[3]?.kind).toEqual({ type: 'todo', due: null });
    expect(t.items[4]?.kind).toEqual({ type: 'snippet', language: 'rust' });
  });

  it('stamps OwnerRef as local-self on every item (Rule 4)', () => {
    const m = baseManifest();
    const t = translateManifestToWriteInputs(m);
    for (const item of t.items) {
      expect(item.owner).toEqual({ type: 'local', id: 'self' });
    }
  });

  it('produces deterministic clientTokens that round-trip across runs', () => {
    const m = baseManifest();
    const t1 = translateManifestToWriteInputs(m);
    const t2 = translateManifestToWriteInputs(m);
    expect(t1.expectedClientTokens).toEqual(t2.expectedClientTokens);
    for (const tok of t1.expectedClientTokens) {
      expect(tok).toMatch(/^pack-[0-9a-f]{16}$/);
    }
  });

  it('clientToken changes when memory content is edited (drift trigger)', () => {
    const id = 'rust-axum' as PackId;
    const v = '1.0.0' as PackVersion;
    const a = derivePackClientToken(id, v, 0, {
      kind: 'fact',
      content: 'original',
    });
    const b = derivePackClientToken(id, v, 0, {
      kind: 'fact',
      content: 'edited',
    });
    expect(a).not.toBe(b);
  });

  it('clientToken is stable when only top-level cosmetic fields change', () => {
    const m1 = baseManifest({ title: 'A', description: 'one' });
    const m2 = baseManifest({ title: 'B', description: 'two' });
    const t1 = translateManifestToWriteInputs(m1);
    const t2 = translateManifestToWriteInputs(m2);
    expect(t1.expectedClientTokens).toEqual(t2.expectedClientTokens);
  });

  it('clientToken is bounded under the MemoryWriteInput.clientToken 128-char ceiling', () => {
    const m = baseManifest();
    const t = translateManifestToWriteInputs(m);
    for (const tok of t.expectedClientTokens) {
      expect(tok.length).toBeLessThanOrEqual(128);
    }
  });
});

describe('checkInstallState', () => {
  it('returns `fresh` when no existing tokens carry the pack tag', () => {
    const state = checkInstallState(['pack-aaaa', 'pack-bbbb'], []);
    expect(state.state).toBe('fresh');
  });

  it('returns `idempotent` when existing tokens exactly match expected', () => {
    const state = checkInstallState(
      ['pack-aaaa', 'pack-bbbb'],
      ['pack-bbbb', 'pack-aaaa'], // order independent
    );
    expect(state.state).toBe('idempotent');
  });

  it('returns `drift` when existing token count differs from expected', () => {
    const state = checkInstallState(
      ['pack-aaaa', 'pack-bbbb'],
      ['pack-aaaa'], // missing one
    );
    expect(state.state).toBe('drift');
    if (state.state === 'drift') {
      expect(state.reason).toContain('changed');
    }
  });

  it('returns `drift` when token sets diverge (content edited)', () => {
    const state = checkInstallState(
      ['pack-aaaa', 'pack-bbbb'],
      ['pack-aaaa', 'pack-cccc'], // bbbb replaced by cccc
    );
    expect(state.state).toBe('drift');
  });
});
