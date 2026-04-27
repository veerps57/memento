// Shared safety-gate factory for destructive command inputs
// (ADR-0012, AGENTS.md rule 12).
//
// Spelled as `z.boolean().refine(v => v === true, ...)` rather
// than `z.literal(true, ...)` so the emitted JSON Schema is
// `{ type: 'boolean' }` with no `const` / `enum` constraint.
//
// This is provider-agnostic by design: a literal-true schema
// converts to `{ type: 'boolean', const: true }` (JSON Schema 7),
// which some LLM function-calling validators (Gemini's, notably)
// reject because they require enum values to be strings. The
// refine spelling is universally accepted, and the runtime
// semantics are identical — only `true` passes parse.
//
// The constraint is communicated to the model via `.describe()`
// so well-behaved clients pass the gate without round-tripping
// through an INVALID_INPUT error first.

import { z } from 'zod';

const CONFIRM_GATE_DESCRIPTION =
  'Must be `true`. Safety gate for destructive operations (ADR-0012); ' +
  'the call is rejected if the field is missing or `false`.';

const CONFIRM_GATE_MESSAGE = 'this operation is destructive; pass { confirm: true } to proceed';

export function confirmGate() {
  return z
    .boolean()
    .refine((v) => v === true, { message: CONFIRM_GATE_MESSAGE })
    .describe(CONFIRM_GATE_DESCRIPTION);
}
