// Text rendering for `memento doctor`.
//
// Pure: input is `DoctorReport` (plus an optional error envelope
// for the failure path), output is a string. The dispatcher
// decides when to call this (TTY + text format) vs when to fall
// through to the standard JSON renderer (pipes / scripts /
// `--format json`).
//
// Why a custom renderer
// ---------------------
//
// The standard text renderer JSON-pretty-prints structured
// values. For `doctor`, that surfaces the report as a wall of
// braces and quotes that operators have to mentally parse.
// `doctor` is the *first command* a user runs after `init` and
// the first they reach for when something is wrong; both
// audiences are better served by a flat ✓ / ✗ list with hints
// inline.
//
// Format mirrors `init`'s walkthrough — same ✓ marker, same
// dim/yellow/bold helpers — so the visual identity is
// consistent across the two onboarding commands.

import type { DoctorReport } from './lifecycle/doctor.js';

export interface DoctorRenderOptions {
  readonly color: boolean;
  /**
   * When the doctor report came back as an error (one or more
   * checks failed), the dispatcher passes the error's `code`
   * and `message` so the failure summary line can name them.
   */
  readonly error?: { readonly code: string; readonly message: string };
}

export function renderDoctorText(report: DoctorReport, options: DoctorRenderOptions): string {
  const lines: string[] = [];
  lines.push(bold('memento doctor', options));
  lines.push('');

  for (const check of report.checks) {
    const mark = check.ok ? green('✓', options) : red('✗', options);
    lines.push(`${mark} ${bold(check.name, options)}  ${dim('—', options)} ${check.message}`);
    if (!check.ok && check.hint !== undefined) {
      lines.push(`  ${dim('hint:', options)} ${check.hint}`);
    }
  }

  lines.push('');
  const total = report.checks.length;
  const failed = report.checks.filter((c) => !c.ok).length;
  if (report.ok) {
    lines.push(`${green('✓', options)} all ${total} checks passed`);
  } else {
    lines.push(
      `${red('✗', options)} ${failed} of ${total} check(s) failed${
        options.error !== undefined ? ` (${options.error.code})` : ''
      }`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

const RESET = '[0m';
const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const BOLD = '[1m';

function green(s: string, opts: DoctorRenderOptions): string {
  return opts.color ? `${GREEN}${s}${RESET}` : s;
}

function red(s: string, opts: DoctorRenderOptions): string {
  return opts.color ? `${RED}${s}${RESET}` : s;
}

function dim(s: string, opts: DoctorRenderOptions): string {
  return opts.color ? `${DIM}${s}${RESET}` : s;
}

function bold(s: string, opts: DoctorRenderOptions): string {
  return opts.color ? `${BOLD}${s}${RESET}` : s;
}
