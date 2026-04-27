// Unit tests for `parseArgv`.
//
// `parseArgv` is a pure function: argv + env → ADT. Every branch
// is reached here. We deliberately do not snapshot — the ADT shape
// is the contract, not a textual representation.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgv } from '../src/argv.js';

const NO_ENV: Readonly<Record<string, string | undefined>> = {};

describe('parseArgv: no positional', () => {
  it('returns help when argv is empty', () => {
    expect(parseArgv({ argv: [], env: NO_ENV })).toEqual({ kind: 'help' });
  });

  it('treats --help alone as help', () => {
    expect(parseArgv({ argv: ['--help'], env: NO_ENV })).toEqual({
      kind: 'help',
    });
    expect(parseArgv({ argv: ['-h'], env: NO_ENV })).toEqual({ kind: 'help' });
  });

  it('treats --version alone as version', () => {
    expect(parseArgv({ argv: ['--version'], env: NO_ENV })).toEqual({
      kind: 'version',
    });
    expect(parseArgv({ argv: ['-V'], env: NO_ENV })).toEqual({
      kind: 'version',
    });
  });

  it('--version wins over --help when both are passed', () => {
    expect(parseArgv({ argv: ['--help', '--version'], env: NO_ENV })).toEqual({
      kind: 'version',
    });
  });
});

describe('parseArgv: lifecycle', () => {
  it('parses serve', () => {
    const parsed = parseArgv({
      argv: ['serve'],
      env: { XDG_DATA_HOME: '/tmp/xdg-data' },
    });
    expect(parsed.kind).toBe('lifecycle');
    if (parsed.kind === 'lifecycle') {
      expect(parsed.name).toBe('serve');
      expect(parsed.subargs).toEqual([]);
      // `path.join` so the assertion matches both POSIX and
      // Windows separator conventions used by Node's path API.
      expect(parsed.env.dbPath).toBe(join('/tmp/xdg-data', 'memento', 'memento.db'));
      expect(parsed.env.format).toBe('auto');
      expect(parsed.env.debug).toBe(false);
    }
  });

  it('parses context with global flags ahead of it', () => {
    const parsed = parseArgv({
      argv: ['--db', '/tmp/x.db', '--format', 'json', '--debug', 'context'],
      env: NO_ENV,
    });
    expect(parsed.kind).toBe('lifecycle');
    if (parsed.kind === 'lifecycle') {
      expect(parsed.name).toBe('context');
      expect(parsed.env.dbPath).toBe('/tmp/x.db');
      expect(parsed.env.format).toBe('json');
      expect(parsed.env.debug).toBe(true);
    }
  });

  it('parses store migrate', () => {
    const parsed = parseArgv({ argv: ['store', 'migrate'], env: NO_ENV });
    expect(parsed.kind).toBe('lifecycle');
    if (parsed.kind === 'lifecycle') {
      expect(parsed.name).toBe('store.migrate');
      expect(parsed.subargs).toEqual([]);
    }
  });

  it('parses doctor', () => {
    const parsed = parseArgv({ argv: ['doctor'], env: NO_ENV });
    expect(parsed.kind).toBe('lifecycle');
    if (parsed.kind === 'lifecycle') {
      expect(parsed.name).toBe('doctor');
      expect(parsed.subargs).toEqual([]);
    }
  });

  it('rejects an unknown store subcommand', () => {
    const parsed = parseArgv({ argv: ['store', 'nuke'], env: NO_ENV });
    expect(parsed.kind).toBe('parseError');
    if (parsed.kind === 'parseError') {
      expect(parsed.message).toContain("'store nuke'");
    }
  });
});

describe('parseArgv: registry', () => {
  it('builds dotted name from <ns> <verb>', () => {
    const parsed = parseArgv({
      argv: ['memory', 'write', '--input', '{}'],
      env: NO_ENV,
    });
    expect(parsed.kind).toBe('registry');
    if (parsed.kind === 'registry') {
      expect(parsed.commandName).toBe('memory.write');
      expect(parsed.subargs).toEqual(['--input', '{}']);
    }
  });

  it('accepts an already-dotted name', () => {
    const parsed = parseArgv({
      argv: ['memory.write', '--input', '{}'],
      env: NO_ENV,
    });
    expect(parsed.kind).toBe('registry');
    if (parsed.kind === 'registry') {
      expect(parsed.commandName).toBe('memory.write');
      expect(parsed.subargs).toEqual(['--input', '{}']);
    }
  });

  it('rejects a single bare token as ambiguous', () => {
    const parsed = parseArgv({ argv: ['memory'], env: NO_ENV });
    expect(parsed.kind).toBe('parseError');
    if (parsed.kind === 'parseError') {
      expect(parsed.message).toContain("unknown command 'memory'");
    }
  });
});

describe('parseArgv: global flags', () => {
  it('honours --db=value form', () => {
    const parsed = parseArgv({
      argv: ['--db=/tmp/y.db', 'context'],
      env: NO_ENV,
    });
    if (parsed.kind === 'lifecycle') expect(parsed.env.dbPath).toBe('/tmp/y.db');
    else throw new Error('expected lifecycle');
  });

  it('reports a missing value for --db', () => {
    const parsed = parseArgv({ argv: ['--db'], env: NO_ENV });
    expect(parsed).toEqual({
      kind: 'parseError',
      message: '--db requires a value',
    });
  });

  it('rejects an unknown --format', () => {
    const parsed = parseArgv({
      argv: ['--format', 'xml', 'context'],
      env: NO_ENV,
    });
    expect(parsed.kind).toBe('parseError');
    if (parsed.kind === 'parseError') expect(parsed.message).toContain('--format');
  });

  it('rejects --config as an unknown flag (removed in #29.3)', () => {
    const parsed = parseArgv({
      argv: ['--config', 'a=1', 'context'],
      env: NO_ENV,
    });
    expect(parsed.kind).toBe('parseError');
    if (parsed.kind === 'parseError') expect(parsed.message).toContain("'--config'");
  });

  it('rejects an unknown global flag', () => {
    const parsed = parseArgv({ argv: ['--colour', 'context'], env: NO_ENV });
    expect(parsed.kind).toBe('parseError');
    if (parsed.kind === 'parseError') expect(parsed.message).toContain("'--colour'");
  });

  it('stops parsing flags at `--` and treats remainder as positionals', () => {
    const parsed = parseArgv({
      argv: ['serve', '--', '--not-a-flag'],
      env: NO_ENV,
    });
    if (parsed.kind !== 'lifecycle') throw new Error('expected lifecycle');
    expect(parsed.subargs).toEqual(['--', '--not-a-flag']);
  });
});

describe('parseArgv: env defaults', () => {
  it('falls back to MEMENTO_DB and MEMENTO_FORMAT', () => {
    const parsed = parseArgv({
      argv: ['context'],
      env: { MEMENTO_DB: '/env/db.sqlite', MEMENTO_FORMAT: 'text' },
    });
    if (parsed.kind !== 'lifecycle') throw new Error('expected lifecycle');
    expect(parsed.env.dbPath).toBe('/env/db.sqlite');
    expect(parsed.env.format).toBe('text');
  });

  it('argv flags win over env vars', () => {
    const parsed = parseArgv({
      argv: ['--db', '/argv/db', 'context'],
      env: { MEMENTO_DB: '/env/db' },
    });
    if (parsed.kind !== 'lifecycle') throw new Error('expected lifecycle');
    expect(parsed.env.dbPath).toBe('/argv/db');
  });

  it('rejects an invalid MEMENTO_FORMAT', () => {
    const parsed = parseArgv({
      argv: ['context'],
      env: { MEMENTO_FORMAT: 'csv' },
    });
    expect(parsed.kind).toBe('parseError');
  });
});
