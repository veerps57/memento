// Doctor walkthrough text-render tests.
//
// Mirrors `init-render.test.ts` in shape — pin the surfaces a
// future refactor would silently break:
//   - both colour modes,
//   - the heading + per-check ✓/✗ marks,
//   - hint lines render only on failure and only when present,
//   - the success / failure summary line is correct.

import { describe, expect, it } from 'vitest';

import { renderDoctorText } from '../src/doctor-render.js';
import type { DoctorReport } from '../src/lifecycle/doctor.js';

const HEALTHY: DoctorReport = {
  ok: true,
  checks: [
    { name: 'node-version', ok: true, message: 'Node 22.11.0 satisfies >= 22.11' },
    { name: 'db-path-writable', ok: true, message: "parent directory '/tmp' is writable" },
    {
      name: 'native-binding',
      ok: true,
      message: 'better-sqlite3 native binding loaded for Node 22.11.0 (modules ABI 127)',
    },
  ],
};

const FAILING: DoctorReport = {
  ok: false,
  checks: [
    { name: 'node-version', ok: true, message: 'Node 22.11.0 satisfies >= 22.11' },
    {
      name: 'native-binding',
      ok: false,
      message: 'better-sqlite3 native binding failed to load: NODE_MODULE_VERSION mismatch',
      hint: 'Run: npm rebuild better-sqlite3 --build-from-source',
    },
    { name: 'database', ok: false, message: 'failed to open database: cascading from native' },
  ],
};

describe('renderDoctorText', () => {
  it('emits no ANSI escapes when colour is off', () => {
    const out = renderDoctorText(HEALTHY, { color: false });
    expect(out).not.toContain('[');
  });

  it('emits ANSI escapes when colour is on', () => {
    const out = renderDoctorText(HEALTHY, { color: true });
    expect(out).toContain('[');
  });

  it('opens with the `memento doctor` heading', () => {
    const out = renderDoctorText(HEALTHY, { color: false });
    expect(out.split('\n')[0]).toBe('memento doctor');
  });

  it('marks every passing check with ✓ and each failing check with ✗', () => {
    const out = renderDoctorText(FAILING, { color: false });
    expect(out).toMatch(/✓\s+node-version/);
    expect(out).toMatch(/✗\s+native-binding/);
    expect(out).toMatch(/✗\s+database/);
  });

  it('renders inline hints when a failing check carries one', () => {
    const out = renderDoctorText(FAILING, { color: false });
    expect(out).toContain('Run: npm rebuild better-sqlite3 --build-from-source');
    // Passing checks never emit a hint line, even if they had one.
    expect(out.split('\n').filter((l) => l.includes('hint:'))).toHaveLength(1);
  });

  it('summarises with "all N checks passed" on success', () => {
    const out = renderDoctorText(HEALTHY, { color: false });
    expect(out).toMatch(/all 3 checks passed/);
  });

  it('summarises with the failure count + error code on failure', () => {
    const out = renderDoctorText(FAILING, {
      color: false,
      error: { code: 'STORAGE_ERROR', message: '2 doctor check(s) failed' },
    });
    expect(out).toMatch(/2 of 3 check\(s\) failed/);
    expect(out).toMatch(/STORAGE_ERROR/);
  });

  it('omits the error-code parenthetical when no error envelope is passed', () => {
    const out = renderDoctorText(FAILING, { color: false });
    // Without the `error` option, the renderer can't name a code.
    expect(out).toMatch(/2 of 3 check\(s\) failed/);
    expect(out).not.toMatch(/STORAGE_ERROR/);
  });
});
