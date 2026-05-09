// Handler-time enforcement of `safety.*` caps. The schema-level
// ceilings (1 MiB / 64 KiB / 1024) are covered by
// `memory-input-bounds.test.ts`; here we pin the operator-tunable
// layer that sits below them. See
// `packages/core/src/commands/memory/safety-caps.ts` for the
// implementation contract.

import { describe, expect, it } from 'vitest';
import {
  assertNoReservedTags,
  enforceSafetyCaps,
  rationaleFromKind,
} from '../../src/commands/memory/safety-caps.js';
import { createConfigStore } from '../../src/config/index.js';

const baseInput = {
  content: 'hello',
  summary: null,
  tags: [] as readonly string[],
};

describe('enforceSafetyCaps', () => {
  it('passes inputs that fit every cap', () => {
    const store = createConfigStore();
    const result = enforceSafetyCaps('memory.write', baseInput, store);
    expect(result.ok).toBe(true);
  });

  it('rejects content that exceeds safety.memoryContentMaxBytes', () => {
    // The schema floor on this key is 1024 bytes. Tests pin the
    // override at the floor and exercise content just past it.
    const store = createConfigStore({ 'safety.memoryContentMaxBytes': 1024 });
    const result = enforceSafetyCaps(
      'memory.write',
      { ...baseInput, content: 'a'.repeat(2048) },
      store,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/safety\.memoryContentMaxBytes/);
      expect(result.error.message).toMatch(/exceeds/);
    }
  });

  it('rejects summary that exceeds safety.summaryMaxBytes', () => {
    const store = createConfigStore({ 'safety.summaryMaxBytes': 64 });
    const result = enforceSafetyCaps(
      'memory.write',
      { ...baseInput, summary: 'a'.repeat(128) },
      store,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/safety\.summaryMaxBytes/);
    }
  });

  it('rejects tag count exceeding safety.tagMaxCount', () => {
    const store = createConfigStore({ 'safety.tagMaxCount': 4 });
    const result = enforceSafetyCaps(
      'memory.write',
      { ...baseInput, tags: ['a', 'b', 'c', 'd', 'e'] },
      store,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/safety\.tagMaxCount/);
    }
  });

  it('rejects rationale exceeding the content cap', () => {
    const store = createConfigStore({ 'safety.memoryContentMaxBytes': 1024 });
    const result = enforceSafetyCaps(
      'memory.write',
      { ...baseInput, rationale: 'a'.repeat(2048) },
      store,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/rationale/);
    }
  });

  it('weaves the batch index into the error message when supplied', () => {
    const store = createConfigStore({ 'safety.memoryContentMaxBytes': 1024 });
    const result = enforceSafetyCaps(
      'memory.write_many',
      { ...baseInput, content: 'a'.repeat(2048) },
      store,
      3,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/items\[3\]/);
    }
  });

  it('measures content in UTF-8 bytes, not UTF-16 code units', () => {
    // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes. 600 'é' chars =
    // 1200 UTF-8 bytes / 600 code units. With a 1024-byte cap,
    // measuring by UTF-16 length (600) would pass; measuring by
    // UTF-8 bytes (1200) must reject.
    const store = createConfigStore({ 'safety.memoryContentMaxBytes': 1024 });
    const result = enforceSafetyCaps(
      'memory.write',
      { ...baseInput, content: 'é'.repeat(600) },
      store,
    );
    expect(result.ok).toBe(false);
  });
});

describe('assertNoReservedTags', () => {
  it('passes through tag arrays without any reserved-prefix entries', () => {
    expect(assertNoReservedTags('memory.write', []).ok).toBe(true);
    expect(assertNoReservedTags('memory.write', ['rust', 'auth']).ok).toBe(true);
    expect(assertNoReservedTags('memory.write', ['source:extracted']).ok).toBe(true);
  });

  it('rejects any tag starting with `pack:`', () => {
    const result = assertNoReservedTags('memory.write', ['pack:rust-axum:1.0.0']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/reserved prefix/);
    }
  });

  it('rejects when even one tag in the array uses the reserved prefix', () => {
    const result = assertNoReservedTags('memory.write_many', ['rust', 'pack:forged:0.1.0', 'auth']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = result.error.details as { offending?: readonly string[] };
      expect(details.offending).toEqual(['pack:forged:0.1.0']);
    }
  });

  it('weaves the batch index into the message when supplied', () => {
    const result = assertNoReservedTags('memory.write_many', ['pack:foo:1.0.0'], 3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/items\[3\]/);
    }
  });
});

describe('rationaleFromKind', () => {
  it('returns the rationale for a decision kind', () => {
    expect(rationaleFromKind({ type: 'decision', rationale: 'because' })).toBe('because');
  });
  it('returns null for non-decision kinds', () => {
    expect(rationaleFromKind({ type: 'fact' })).toBe(null);
    expect(rationaleFromKind({ type: 'preference' })).toBe(null);
  });
  it('returns null when decision rationale is missing', () => {
    expect(rationaleFromKind({ type: 'decision' })).toBe(null);
  });
});
