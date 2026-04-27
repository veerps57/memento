// Renders `docs/reference/error-codes.md` from `ERROR_CODES`
// and `ERROR_CODE_DESCRIPTIONS` in `@psraghuveer/memento-schema`.
//
// The closed enum of error codes is the contract callers may
// switch on. The user-facing description for each code lives in
// `ERROR_CODE_DESCRIPTIONS` (typed as `Record<ErrorCode, string>`
// so adding a code without a description is a compile error).

import { ERROR_CODES, ERROR_CODE_DESCRIPTIONS } from '@psraghuveer/memento-schema';
import { renderHeader } from './shared.js';

export function renderErrorCodesDoc(): string {
  const lines: string[] = [];
  lines.push(
    renderHeader('Error Codes', '@psraghuveer/memento-schema/result', [
      'Every fallible Memento operation returns a `Result<T>`; on the failure branch, `error.code` is one of the values listed below.',
      'Codes are stable contract — switch on them, map them to localised messages, build retry policies on top.',
      'Adding a code is non-breaking. Repurposing or removing one is breaking and goes through a deprecation cycle.',
    ]),
  );
  lines.push('');
  const total: number = ERROR_CODES.length;
  lines.push(`Total: ${total} code${total === 1 ? '' : 's'}.`);
  lines.push('');
  lines.push('| Code | Description |');
  lines.push('| --- | --- |');
  for (const code of ERROR_CODES) {
    const description = ERROR_CODE_DESCRIPTIONS[code].replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    lines.push(`| \`${code}\` | ${description} |`);
  }
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}
