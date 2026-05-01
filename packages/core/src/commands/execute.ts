// Validating execute path for commands.
//
// Adapters (MCP, CLI) call `executeCommand` rather than invoking a
// handler directly. This is the single chokepoint that guarantees:
//
// - Inputs are parsed against the command's Zod schema. Shape
//   errors become `INVALID_INPUT` `Result.err`s, not exceptions
//   that escape the transport boundary as opaque 500s.
// - Outputs are validated against the command's output schema on
//   the way out. Drift between handler and schema fails the test
//   suite (and the contract test) rather than silently emitting
//   malformed responses.
// - The raw input is read once, parsed once. Transports do not
//   re-parse; in-process callers (tests) get the exact same
//   semantics as MCP and CLI.
//
// `executeCommand` is generic over the command's input/output
// schemas so call sites get back `Result<z.infer<O>>` precisely
// — even though the registry stores `AnyCommand` after erasure.

import type { MementoError, Result } from '@psraghuveer/memento-schema';
import { err } from '@psraghuveer/memento-schema';
import type { z } from 'zod';
import type { ZodIssue } from 'zod';
import type { Command, CommandContext } from './types.js';

/**
 * Format Zod issues into a concise, actionable summary string.
 *
 * Produces lines like:
 *   - scope: Required
 *   - kind.type: Invalid literal value, expected "fact"
 *   - storedConfidence: Number must be less than or equal to 1
 *
 * Capped at 5 issues to avoid overwhelming the caller.
 */
function formatZodIssues(issues: readonly ZodIssue[]): string {
  const lines = issues.slice(0, 5).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  if (issues.length > 5) {
    lines.push(`  ... and ${issues.length - 5} more issue(s)`);
  }
  return lines.join('\n');
}

/**
 * Run a command end-to-end with input + output validation.
 *
 * The function is intentionally non-throwing: any error reaches
 * the caller as a `Result<…, MementoError>`. The two failure
 * modes are:
 *
 * - `INVALID_INPUT` when the raw input rejects against
 *   `command.inputSchema`. The Zod issue list is attached
 *   verbatim under `details.issues`.
 * - `INTERNAL` when the handler returned successfully but its
 *   value rejected against `command.outputSchema`. This is a
 *   programmer error, not a user error — it means the handler
 *   and the schema disagree. We surface it rather than swallow
 *   it because silent output drift is the failure the schema
 *   exists to prevent.
 *
 * Handler-returned `err(...)`s are passed through unchanged.
 */
export async function executeCommand<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  command: Command<I, O>,
  rawInput: unknown,
  ctx: CommandContext,
): Promise<Result<z.infer<O>>> {
  const parsedInput = command.inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    const summary = formatZodIssues(parsedInput.error.issues);
    return err<MementoError>({
      code: 'INVALID_INPUT',
      message: `Invalid input for command '${command.name}':\n${summary}`,
      details: { issues: parsedInput.error.issues },
    });
  }

  const handlerResult = await command.handler(parsedInput.data, ctx);
  if (!handlerResult.ok) {
    return handlerResult;
  }

  const parsedOutput = command.outputSchema.safeParse(handlerResult.value);
  if (!parsedOutput.success) {
    return err<MementoError>({
      code: 'INTERNAL',
      message: `Command '${command.name}' returned a value that does not match its declared output schema`,
      details: { issues: parsedOutput.error.issues },
    });
  }

  return { ok: true, value: parsedOutput.data as z.infer<O> };
}
