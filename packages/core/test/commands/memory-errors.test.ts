// Tests for `repoErrorToMementoError` — the canonical
// pattern-matching function at `commands/errors.ts` that
// translates repository-layer exceptions into structured
// `MementoError` codes. Every branch is exercised.

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { repoErrorToMementoError } from '../../src/commands/errors.js';

describe('repoErrorToMementoError', () => {
  // ── ZodError → INVALID_INPUT ──────────────────────────────
  it('maps ZodError to INVALID_INPUT with issues in details', () => {
    const zodErr = new ZodError([
      {
        code: 'invalid_type',
        expected: 'array',
        received: 'string',
        path: ['embedding'],
        message: 'Expected array, received string',
      },
    ]);
    const result = repoErrorToMementoError(zodErr, 'setEmbedding');
    expect(result.code).toBe('INVALID_INPUT');
    expect(result.message).toContain('setEmbedding');
    expect(result.message).toContain('schema validation');
    expect((result as { details?: unknown }).details).toHaveProperty('issues');
  });

  // ── non-Error → INTERNAL ──────────────────────────────────
  it('maps non-Error thrown value to INTERNAL', () => {
    const result = repoErrorToMementoError('boom', 'write');
    expect(result.code).toBe('INTERNAL');
    expect(result.message).toContain('non-Error thrown');
  });

  it('maps null thrown value to INTERNAL', () => {
    const result = repoErrorToMementoError(null, 'write');
    expect(result.code).toBe('INTERNAL');
    expect(result.message).toContain('non-Error thrown');
  });

  // ── NOT_FOUND ──��──────────────────────────────────────────
  it('maps "memory not found" to NOT_FOUND', () => {
    const result = repoErrorToMementoError(new Error('forget: memory not found: M01'), 'forget');
    expect(result.code).toBe('NOT_FOUND');
  });

  it('maps "conflict not found" to NOT_FOUND', () => {
    const result = repoErrorToMementoError(
      new Error('resolve: conflict not found: C01'),
      'resolve',
    );
    expect(result.code).toBe('NOT_FOUND');
  });

  // ── CONFLICT ─────��────────────────────────────────────────
  it('maps "is not active" to CONFLICT', () => {
    const result = repoErrorToMementoError(
      new Error('supersede: memory M01 is not active (status=forgotten)'),
      'supersede',
    );
    expect(result.code).toBe('CONFLICT');
  });

  it('maps "not in [" to CONFLICT', () => {
    const result = repoErrorToMementoError(
      new Error('archive: memory M01 status=forgotten not in [active]'),
      'archive',
    );
    expect(result.code).toBe('CONFLICT');
  });

  it('maps "race detected" to CONFLICT', () => {
    const result = repoErrorToMementoError(
      new Error('supersede: race detected on M01'),
      'supersede',
    );
    expect(result.code).toBe('CONFLICT');
  });

  it('maps "already resolved" to CONFLICT', () => {
    const result = repoErrorToMementoError(
      new Error('resolve: conflict C01 already resolved (kept_existing)'),
      'resolve',
    );
    expect(result.code).toBe('CONFLICT');
  });

  // ── INVALID_INPUT (patch) ─────────────────────────────────
  it('maps "patch must change" to INVALID_INPUT', () => {
    const result = repoErrorToMementoError(
      new Error('update: patch must change at least one field'),
      'update',
    );
    expect(result.code).toBe('INVALID_INPUT');
    expect(result.message).toContain('patch must change');
  });

  // ── CONFIG_ERROR (VectorRetrievalConfigError) ─────────────
  it('maps VectorRetrievalConfigError to CONFIG_ERROR', () => {
    const err = new Error('vector retrieval requires an embedding provider');
    err.name = 'VectorRetrievalConfigError';
    const result = repoErrorToMementoError(err, 'search');
    expect(result.code).toBe('CONFIG_ERROR');
  });

  // ── INVALID_INPUT (RangeError) ────────────────────────────
  it('maps RangeError to INVALID_INPUT', () => {
    const result = repoErrorToMementoError(
      new RangeError('limit must be a positive integer'),
      'list',
    );
    expect(result.code).toBe('INVALID_INPUT');
  });

  // ── STORAGE_ERROR (SQLite) ─────���──────────────────────────
  it('maps SQLITE_ prefix to STORAGE_ERROR', () => {
    const result = repoErrorToMementoError(
      new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'),
      'write',
    );
    expect(result.code).toBe('STORAGE_ERROR');
  });

  it('maps "constraint failed" to STORAGE_ERROR', () => {
    const result = repoErrorToMementoError(new Error('constraint failed: memories.id'), 'write');
    expect(result.code).toBe('STORAGE_ERROR');
  });

  it('maps "database is locked" to STORAGE_ERROR', () => {
    const result = repoErrorToMementoError(new Error('database is locked'), 'write');
    expect(result.code).toBe('STORAGE_ERROR');
  });

  // ── fallback → INTERNAL ───────────────────────────────────
  it('maps unknown Error to INTERNAL', () => {
    const result = repoErrorToMementoError(new Error('something completely unexpected'), 'write');
    expect(result.code).toBe('INTERNAL');
    expect(result.message).toContain('something completely unexpected');
  });

  // Path-redaction (security hardening): host filesystem layout
  // must not leak through INTERNAL or STORAGE_ERROR messages
  // returned to MCP clients. The path-bearing messages SQLite
  // and Node FS produce on real failures (e.g. SQLITE_CANTOPEN)
  // get their absolute paths replaced with `<path>`.
  describe('path redaction', () => {
    it('redacts a POSIX absolute DB path in a STORAGE_ERROR message', () => {
      const e = new Error(
        'SQLITE_CANTOPEN: unable to open database file: /Users/alice/.local/share/memento/memento.db',
      );
      const r = repoErrorToMementoError(e, 'open');
      expect(r.code).toBe('STORAGE_ERROR');
      expect(r.message).toContain('<path>');
      expect(r.message).not.toContain('/Users/alice');
      expect(r.message).not.toContain('memento.db');
    });

    it('redacts a Windows drive-letter path in an INTERNAL message', () => {
      const e = new Error('something failed at C:\\Users\\bob\\AppData\\Roaming\\memento');
      const r = repoErrorToMementoError(e, 'misc');
      expect(r.code).toBe('INTERNAL');
      expect(r.message).toContain('<path>');
      expect(r.message).not.toContain('Users\\bob');
    });

    it('does not touch well-known structured messages (NOT_FOUND, CONFLICT)', () => {
      // Well-known messages don't carry filesystem paths, so the
      // happy-path UX (id-bearing error messages) is preserved.
      const r = repoErrorToMementoError(new Error('forget: memory not found: 01HYXZ'), 'forget');
      expect(r.code).toBe('NOT_FOUND');
      expect(r.message).toContain('01HYXZ');
      expect(r.message).not.toContain('<path>');
    });

    it('leaves prose without paths intact in INTERNAL messages', () => {
      const e = new Error('random failure with no paths');
      const r = repoErrorToMementoError(e, 'misc');
      expect(r.code).toBe('INTERNAL');
      expect(r.message).toBe('random failure with no paths');
    });
  });
});
