// Unit tests for `readRegistryInput`.
//
// These pin the contract that argument errors come back as
// `Result.err` (never thrown) before the database is opened,
// and that all three documented input shapes — literal JSON,
// `@file`, `-` (stdin) — round-trip the same value.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { rmTmpSync } from './_helpers/rm-tmp.js';

import type { CliIO } from '../src/io.js';
import { readRegistryInput } from '../src/registry-run.js';

function ioWithStdin(stdinChunks: readonly string[] = []): CliIO {
  const stdin = Readable.from(stdinChunks);
  return {
    argv: [],
    env: {},
    stdin,
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    isTTY: false,
    isStderrTTY: false,
    exit: ((code: number): never => {
      throw new Error(`unexpected exit ${code}`);
    }) as CliIO['exit'],
  };
}

describe('readRegistryInput', () => {
  it('returns {} when no --input is supplied', async () => {
    const result = await readRegistryInput([], ioWithStdin());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({});
  });

  it('parses a literal JSON value', async () => {
    const result = await readRegistryInput(['--input', '{"limit":3}'], ioWithStdin());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ limit: 3 });
  });

  it('accepts the --input=value form', async () => {
    const result = await readRegistryInput(['--input={"pinned":true}'], ioWithStdin());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ pinned: true });
  });

  it("reads stdin when --input is '-'", async () => {
    const result = await readRegistryInput(['--input', '-'], ioWithStdin(['{"limit":', '7}']));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ limit: 7 });
  });

  it('reads a file when --input starts with @', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memento-cli-input-'));
    try {
      const file = join(dir, 'input.json');
      writeFileSync(file, '{"kind":"fact"}', 'utf8');
      const result = await readRegistryInput([`--input=@${file}`], ioWithStdin());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ kind: 'fact' });
    } finally {
      rmTmpSync(dir);
    }
  });

  it('returns INVALID_INPUT when JSON is malformed', async () => {
    const result = await readRegistryInput(['--input', '{not-json'], ioWithStdin());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('not valid JSON');
  });

  it('returns INVALID_INPUT when --input has no value', async () => {
    const result = await readRegistryInput(['--input'], ioWithStdin());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toBe('--input requires a value');
  });

  it('returns INVALID_INPUT when --input appears twice', async () => {
    const result = await readRegistryInput(['--input', '{}', '--input', '{}'], ioWithStdin());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toBe('--input may only appear once');
  });

  it('rejects unknown subargs with a crisp error', async () => {
    const result = await readRegistryInput(['--limit', '5'], ioWithStdin());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain("unknown argument '--limit'");
  });

  it('reports a readable error when @file does not exist', async () => {
    const result = await readRegistryInput(
      ['--input', '@/no/such/path/should/exist.json'],
      ioWithStdin(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('failed to read --input');
  });

  it('treats an empty literal as an empty object', async () => {
    const result = await readRegistryInput(['--input', '   '], ioWithStdin());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({});
  });
});
