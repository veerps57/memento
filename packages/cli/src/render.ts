// Render a `Result` for CLI consumption.
//
// Two callers share the same binary:
//
// - **Pipes / scripts** want machine-readable JSON on a single
//   line per result, with non-zero exit on error. `format=json`.
// - **Humans** want a short, readable line — the value if it is a
//   string, JSON-pretty if it is structured, or `error: CODE: msg`.
//   `format=text`.
//
// This module owns the mapping from `Result<T>` to bytes and
// nothing else. It does not pick a default format (callers do,
// based on `io.isTTY` plus `--format` / `MEMENTO_FORMAT`), it does
// not pick an exit code (callers use `exit-codes.ts`). One concern,
// one module.

import type { Result } from '@psraghuveer/memento-schema';

/** The two on-the-wire formats. `auto` is resolved before reaching `renderResult`. */
export type CliFormat = 'json' | 'text';

/** What `--format` and `MEMENTO_FORMAT` may carry before TTY resolution. */
export type CliFormatOption = CliFormat | 'auto';

export interface RenderedResult {
  /** Bytes for stdout. Empty when the entire result goes to stderr. */
  readonly stdout: string;
  /** Bytes for stderr. Empty when the entire result is success on stdout. */
  readonly stderr: string;
}

/**
 * Resolve `auto` to a concrete format using the TTY signal:
 * humans on a terminal get prose, pipes and scripts get JSON.
 *
 * Lives here (next to the formats themselves) rather than in the
 * dispatcher so `argv.ts` stays a pure parser.
 */
export function resolveFormat(option: CliFormatOption, isTTY: boolean): CliFormat {
  if (option === 'auto') return isTTY ? 'text' : 'json';
  return option;
}

export function renderResult(result: Result<unknown>, format: CliFormat): RenderedResult {
  return format === 'json' ? renderJson(result) : renderText(result);
}

function renderJson(result: Result<unknown>): RenderedResult {
  const line = `${JSON.stringify(result)}\n`;
  return result.ok ? { stdout: line, stderr: '' } : { stdout: '', stderr: line };
}

function renderText(result: Result<unknown>): RenderedResult {
  if (result.ok) {
    if (result.value === undefined || result.value === null) {
      return { stdout: 'ok\n', stderr: '' };
    }
    return { stdout: `${stringifyForText(result.value)}\n`, stderr: '' };
  }
  const { code, message, details, hint } = result.error;
  let line = `error: ${code}: ${message}\n`;
  if (hint !== undefined) {
    line += `hint: ${hint}\n`;
  }
  if (details !== undefined) {
    line += `details: ${stringifyForText(details)}\n`;
  }
  return { stdout: '', stderr: line };
}

function stringifyForText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
