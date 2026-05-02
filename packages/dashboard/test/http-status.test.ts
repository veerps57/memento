// Unit tests for `httpStatusForError`.
//
// The mapper is pure logic — given a `Result.err.code`, return
// the HTTP status the route should respond with. Synthesising
// each code through a real `executeCommand` requires a corrupt
// DB / broken embedder / racing supersedence, so the mapper is
// pinned directly rather than via integration. Aligns with how
// other pure helpers in this package are tested (`format.ts`,
// `cn.ts`).

import { describe, expect, it } from 'vitest';

import { httpStatusForError } from '../src/server/commands.js';

describe('httpStatusForError', () => {
  it('maps NOT_FOUND to 404', () => {
    expect(httpStatusForError('NOT_FOUND')).toBe(404);
  });

  it('maps CONFLICT to 409', () => {
    expect(httpStatusForError('CONFLICT')).toBe(409);
  });

  it('maps STORAGE_ERROR to 500 (server-side)', () => {
    expect(httpStatusForError('STORAGE_ERROR')).toBe(500);
  });

  it('maps EMBEDDER_ERROR to 500 (server-side)', () => {
    expect(httpStatusForError('EMBEDDER_ERROR')).toBe(500);
  });

  it('maps INTERNAL to 500 (server-side)', () => {
    expect(httpStatusForError('INTERNAL')).toBe(500);
  });

  it('falls through to 400 for caller-side codes (INVALID_INPUT, IMMUTABLE, CONFIG_ERROR, SCRUBBED)', () => {
    expect(httpStatusForError('INVALID_INPUT')).toBe(400);
    expect(httpStatusForError('IMMUTABLE')).toBe(400);
    expect(httpStatusForError('CONFIG_ERROR')).toBe(400);
    expect(httpStatusForError('SCRUBBED')).toBe(400);
  });

  it('falls through to 400 for any unknown code (forward-compat default)', () => {
    // A future error code added to the registry that the dashboard
    // hasn't been updated for should default to 400 — the safer
    // bet that the caller can do something about it.
    expect(httpStatusForError('FUTURE_CODE_NOT_YET_KNOWN')).toBe(400);
  });
});
