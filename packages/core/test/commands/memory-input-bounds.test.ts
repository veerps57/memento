// Phase 1 hardening: structural ceilings on `memory.write` wire
// inputs.
//
// These bounds (`content` ≤ 1 MiB, `summary` ≤ 64 KiB, `tags` ≤
// 1024 entries) are the *hard* limits — operator-tunable caps
// from `safety.*` config keys sit below them and are enforced at
// handler time. The schema bounds exist so a misbehaving peer
// cannot push past these limits regardless of config.
//
// We assert the schema directly rather than running through the
// full command path: the cap is a structural property of the
// input shape, and exercising the storage layer would only add
// noise.

import { describe, expect, it } from 'vitest';
import { MemoryWriteInputSchema } from '../../src/commands/memory/inputs.js';

const baseInput = {
  scope: { type: 'global' as const },
  kind: { type: 'fact' as const },
  tags: [],
  content: 'x',
};

describe('MemoryWriteInputSchema — structural bounds', () => {
  it('rejects content larger than 1 MiB', () => {
    const oneMib = 1024 * 1024;
    const result = MemoryWriteInputSchema.safeParse({
      ...baseInput,
      content: 'a'.repeat(oneMib + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('content');
    }
  });

  it('accepts content at exactly 1 MiB', () => {
    const oneMib = 1024 * 1024;
    const result = MemoryWriteInputSchema.safeParse({
      ...baseInput,
      content: 'a'.repeat(oneMib),
    });
    expect(result.success).toBe(true);
  });

  it('rejects summary larger than 64 KiB', () => {
    const cap = 64 * 1024;
    const result = MemoryWriteInputSchema.safeParse({
      ...baseInput,
      summary: 'a'.repeat(cap + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('summary');
    }
  });

  it('rejects more than 1024 tags', () => {
    const tags = Array.from({ length: 1025 }, (_, i) => `tag-${i}`);
    const result = MemoryWriteInputSchema.safeParse({ ...baseInput, tags });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('tags');
    }
  });

  it('accepts the bound counts at the cap', () => {
    const tags = Array.from({ length: 1024 }, (_, i) => `tag-${i}`);
    const result = MemoryWriteInputSchema.safeParse({
      ...baseInput,
      tags,
      summary: 'a'.repeat(64 * 1024),
    });
    expect(result.success).toBe(true);
  });
});
