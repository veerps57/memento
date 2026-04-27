// Map exceptions thrown by the repository layer into the
// structured `MementoError` codes used by `Result.err`.
//
// The repository throws bare `Error`s with messages constructed
// at the throw site (e.g. `'forget: memory not found: …'`,
// `'supersede: memory … is not active (status=…)'`,
// `'update: patch must change at least one field'`). We don't
// want to push string-matching into every command, so this
// module owns the (small, exhaustive) set of patterns once.
//
// Anything we don't recognise becomes `INTERNAL`. That is
// deliberate: surfacing an unknown failure as `STORAGE_ERROR`
// would be a guess, and `INTERNAL` is the documented "we don't
// know what happened" code per `docs/reference/error-codes.md`.
//
// We also recognise `ZodError` (raised by `EmbeddingSchema.parse`
// inside `setEmbedding` for vector/dimension mismatch — the only
// repo-internal `parse` call that runs on caller-supplied data
// after the command's own input validation). Those become
// `INVALID_INPUT` because that's exactly what they are: the
// caller's input passed the command's input schema but failed
// the deeper cross-field invariant.

import type { MementoError } from '@psraghuveer/memento-schema';
import { ZodError } from 'zod';

/**
 * Translate an error thrown out of a `MemoryRepository` call into
 * a `MementoError`. Pattern-matches on the messages constructed
 * by the repository; falls back to `INTERNAL` for the unknown.
 *
 * The `op` argument is used only for the resulting error
 * `message`. It is not part of the matching contract — the repo
 * messages already carry the operation name.
 */
export function repoErrorToMementoError(error: unknown, op: string): MementoError {
  if (error instanceof ZodError) {
    return {
      code: 'INVALID_INPUT',
      message: `${op}: input failed schema validation`,
      details: { issues: error.issues },
    };
  }
  if (!(error instanceof Error)) {
    return {
      code: 'INTERNAL',
      message: `${op}: non-Error thrown`,
      details: { thrown: String(error) },
    };
  }

  const msg = error.message;

  // "<op>: memory not found: <id>"
  if (/: memory not found:/.test(msg)) {
    return { code: 'NOT_FOUND', message: msg };
  }
  // "supersede: memory <id> is not active (status=<status>)"
  // "<op>: memory <id> status=<status> not in [<list>]"
  // "supersede: race detected on <id>"
  if (/\bis not active\b/.test(msg) || /\bnot in \[/.test(msg) || /\brace detected\b/.test(msg)) {
    return { code: 'CONFLICT', message: msg };
  }
  // "update: patch must change at least one field"
  if (/\bpatch must change\b/.test(msg)) {
    return { code: 'INVALID_INPUT', message: msg };
  }
  // RangeError("limit must be a positive integer")
  if (error instanceof RangeError) {
    return { code: 'INVALID_INPUT', message: msg };
  }
  // SQLite FK / constraint failures bubble up as Error from
  // better-sqlite3. Treat as STORAGE_ERROR rather than INTERNAL
  // so operators can grep for them.
  if (
    /SQLITE_/.test(msg) ||
    /\bconstraint failed\b/i.test(msg) ||
    /\bdatabase is locked\b/i.test(msg)
  ) {
    return { code: 'STORAGE_ERROR', message: msg };
  }

  return { code: 'INTERNAL', message: msg };
}
