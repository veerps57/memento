// Mapping from MementoError codes to CLI process exit codes.
//
// Scripts pipe `memento ...` and switch on `$?`. The mapping is
// part of the public contract: it must be stable, exhaustive,
// and obvious. We keep it close to the conventions in
// `sysexits.h` / typical Unix tools while staying small and
// memorable:
//
//   0   ok
//   1   usage / unhandled exception (argv parse, unknown command)
//   2+  one slot per `ErrorCode`, in the order declared in
//       `@psraghuveer/memento-schema`'s `ERROR_CODES`. Stable across versions.
//
// The map is typed as `Record<ErrorCode, number>` so adding a
// new code to `ERROR_CODES` is a TypeScript error here until a
// slot is assigned — drift between the closed enum and the CLI
// contract is impossible.

import type { ErrorCode } from '@psraghuveer/memento-schema';

/** Exit code for `Result.ok`. */
export const EXIT_OK = 0;

/** Exit code for argv parse errors and uncaught exceptions. */
export const EXIT_USAGE = 1;

export const ERROR_CODE_TO_EXIT: Record<ErrorCode, number> = {
  INVALID_INPUT: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  IMMUTABLE: 5,
  CONFIG_ERROR: 6,
  SCRUBBED: 7,
  STORAGE_ERROR: 8,
  EMBEDDER_ERROR: 9,
  INTERNAL: 10,
};

/**
 * Resolve the exit code for a structured error. Total: every
 * `ErrorCode` has a slot.
 */
export function exitCodeFor(code: ErrorCode): number {
  return ERROR_CODE_TO_EXIT[code];
}
