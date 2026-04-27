// Unit tests for `renderResult`.

import { err, ok } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { renderResult } from '../src/render.js';

describe('renderResult: json', () => {
  it('writes ok results to stdout as a single line', () => {
    const out = renderResult(ok({ id: 'm_1' }), 'json');
    expect(out.stdout).toBe('{"ok":true,"value":{"id":"m_1"}}\n');
    expect(out.stderr).toBe('');
  });

  it('writes err results to stderr as a single line', () => {
    const out = renderResult(
      err({ code: 'NOT_FOUND', message: 'no such id', details: { id: 'm_x' } }),
      'json',
    );
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('"ok":false');
    expect(out.stderr).toContain('"NOT_FOUND"');
    expect(out.stderr.endsWith('\n')).toBe(true);
  });
});

describe('renderResult: text', () => {
  it('prints "ok" for null/undefined values', () => {
    expect(renderResult(ok(null), 'text').stdout).toBe('ok\n');
    expect(renderResult(ok(undefined), 'text').stdout).toBe('ok\n');
  });

  it('prints a string value verbatim', () => {
    expect(renderResult(ok('hello'), 'text').stdout).toBe('hello\n');
  });

  it('pretty-prints structured ok values', () => {
    const out = renderResult(ok({ id: 'm_1' }), 'text');
    expect(out.stdout).toBe('{\n  "id": "m_1"\n}\n');
  });

  it('formats errors with code and message on stderr', () => {
    const out = renderResult(err({ code: 'INVALID_INPUT', message: 'bad shape' }), 'text');
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('error: INVALID_INPUT: bad shape\n');
  });

  it('appends details when present', () => {
    const out = renderResult(
      err({ code: 'CONFLICT', message: 'race', details: { attempt: 2 } }),
      'text',
    );
    expect(out.stderr).toContain('error: CONFLICT: race');
    expect(out.stderr).toContain('details:');
    expect(out.stderr).toContain('"attempt": 2');
  });
});
