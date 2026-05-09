import { PackIdSchema, PackVersionSchema } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';

import {
  buildAllVersionsUninstallTagPrefix,
  buildSingleVersionUninstallFilter,
  memoryHasAnyVersionOfPack,
  uninstallListFilter,
} from '../../src/packs/uninstall.js';

const id = PackIdSchema.parse('rust-axum');
const v1 = PackVersionSchema.parse('1.0.0');
const v2 = PackVersionSchema.parse('1.2.0');

describe('buildSingleVersionUninstallFilter', () => {
  it('returns a tag-and-status filter scoped to one pack version', () => {
    const f = buildSingleVersionUninstallFilter(id, v1);
    expect(f.tags).toEqual(['pack:rust-axum:1.0.0']);
    expect(f.status).toBe('active');
  });
});

describe('uninstallListFilter', () => {
  it('produces a MemoryListFilter for memory.forget_many', () => {
    const f = uninstallListFilter(id, v2);
    expect(f.tags).toEqual(['pack:rust-axum:1.2.0']);
    expect(f.status).toBe('active');
  });
});

describe('buildAllVersionsUninstallTagPrefix', () => {
  it('returns the `pack:<id>:` prefix used to match every version', () => {
    expect(buildAllVersionsUninstallTagPrefix(id)).toBe('pack:rust-axum:');
  });
});

describe('memoryHasAnyVersionOfPack', () => {
  it('returns true when any tag matches the all-versions prefix', () => {
    expect(memoryHasAnyVersionOfPack(id, ['pack:rust-axum:1.0.0', 'auth'])).toBe(true);
    expect(memoryHasAnyVersionOfPack(id, ['rust', 'pack:rust-axum:0.5.0'])).toBe(true);
  });

  it('returns false when no tags carry this pack', () => {
    expect(memoryHasAnyVersionOfPack(id, ['rust', 'auth'])).toBe(false);
    expect(memoryHasAnyVersionOfPack(id, ['pack:other:1.0.0'])).toBe(false);
  });

  it('returns false on empty tags', () => {
    expect(memoryHasAnyVersionOfPack(id, [])).toBe(false);
  });
});
