// Shared Zod-issue formatter.
//
// Extracted from `execute.ts` so the same `INVALID_INPUT: …\n  -
// field.path: detail` shape is emitted by every error path, not
// only by the top-of-handler input parser. Before this lived in
// its own module the repository-error mapper in `errors.ts` had
// to fall back to a terse `INVALID_INPUT: <op>: input failed
// schema validation` message because it did not have access to
// the formatter — see the original finding.

import type { ZodIssue } from 'zod';

/**
 * Format Zod issues into a concise, actionable summary string.
 *
 * Produces lines like:
 *   - scope: Required
 *   - kind.type: Invalid literal value, expected "fact"
 *   - storedConfidence: Number must be less than or equal to 1
 *
 * Capped at 5 issues to avoid overwhelming the caller. Long-tail
 * issues are summarised with a `... and N more issue(s)` line.
 */
export function formatZodIssues(issues: readonly ZodIssue[]): string {
  const lines = issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  if (issues.length > 5) {
    lines.push(`  ... and ${issues.length - 5} more issue(s)`);
  }
  return lines.join('\n');
}
