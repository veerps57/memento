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
//
// Path redaction. `INTERNAL` and `STORAGE_ERROR` messages
// originate from `better-sqlite3` / Node FS errors and may
// include absolute filesystem paths (e.g.
// `SQLITE_CANTOPEN: unable to open database file: /Users/.../memento.db`).
// Those reach the MCP peer through `executeCommand`'s `Result.err`
// envelope. To keep host filesystem layout off the wire we run
// the message through `redactPaths` before returning. The
// well-known repo error patterns above don't carry absolute
// paths, so they are returned as-is for actionable error UX.

import type { MementoError } from '@psraghuveer/memento-schema';
import { ZodError } from 'zod';

/**
 * Replace absolute filesystem paths in a message with a
 * `<path>` placeholder so error returns to MCP clients don't
 * leak host layout. POSIX absolute paths (`/foo/bar`) and
 * Windows drive-letter paths (`C:\foo\bar`) are both matched.
 *
 * The redaction is intentionally conservative — it does not
 * touch relative paths or fragments like `id=…` because those
 * are useful in error messages and don't disclose host layout.
 */
export function redactPaths(message: string): string {
  // POSIX absolute path: starts with `/`, contains at least one
  // additional component. Stop at whitespace, quote, or
  // line-ending punctuation so we don't munch through prose.
  const posix = /\/(?:[^\s'"`,;)\]}]+\/)*[^\s'"`,;)\]}]+/g;
  // Windows drive-letter path: `C:\foo\bar`. Single backslashes
  // get doubled inside JS regex literals.
  const win = /[A-Za-z]:\\(?:[^\s'"`,;)\]}\\]+\\)*[^\s'"`,;)\]}\\]+/g;
  return message.replace(posix, '<path>').replace(win, '<path>');
}

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
  // "resolve: conflict not found: <id>"
  if (/: (memory|conflict) not found:/.test(msg)) {
    return { code: 'NOT_FOUND', message: msg };
  }
  // "supersede: memory <id> is not active (status=<status>)"
  // "<op>: memory <id> status=<status> not in [<list>]"
  // "supersede: race detected on <id>"
  // "resolve: conflict <id> already resolved (<resolution>)"
  if (
    /\bis not active\b/.test(msg) ||
    /\bnot in \[/.test(msg) ||
    /\brace detected\b/.test(msg) ||
    /\balready resolved\b/.test(msg)
  ) {
    return { code: 'CONFLICT', message: msg };
  }
  // "update: patch must change at least one field"
  if (/\bpatch must change\b/.test(msg)) {
    return { code: 'INVALID_INPUT', message: msg };
  }
  // Pipeline-typed retrieval misconfiguration:
  // - `retrieval.vector.enabled` is true but no embedder wired;
  // - a row's stored embedding model/dimension drifted from the
  //   configured provider (run `embedding rebuild`).
  // The pipeline raises `VectorRetrievalConfigError`; we map it
  // by name so the surface (CLI/MCP) sees a stable CONFIG_ERROR.
  if (error.name === 'VectorRetrievalConfigError') {
    return { code: 'CONFIG_ERROR', message: msg };
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
    return { code: 'STORAGE_ERROR', message: redactPaths(msg) };
  }

  return { code: 'INTERNAL', message: redactPaths(msg) };
}
