import { z } from 'zod';

/**
 * `ErrorCode` is the closed set of stable error identifiers the
 * runtime emits across CLI, MCP, and internal APIs. Codes are
 * **stable contract**: callers may switch on them and integrators
 * may map them to localised messages. Never repurpose an existing
 * code; add a new one.
 *
 * The set is deliberately small. Most failure modes fit one of:
 *
 * - `INVALID_INPUT`      — shape/value rejected by a Zod schema or
 *                          a domain invariant (e.g. updated-event
 *                          patch is empty).
 * - `NOT_FOUND`          — the addressed memory / event / scope /
 *                          config key does not exist.
 * - `CONFLICT`           — optimistic-concurrency or supersedence
 *                          race; the caller should re-read.
 * - `IMMUTABLE`          — attempt to mutate a field or config key
 *                          that is fixed after server start
 *                          (e.g. `server.transport`, `storage.path`).
 * - `CONFIG_ERROR`       — config write rejected by the per-key
 *                          schema; distinct from `INVALID_INPUT`
 *                          so config callers can render history.
 * - `SCRUBBED`           — write rejected because scrubbing removed
 *                          all meaningful content.
 * - `STORAGE_ERROR`      — SQLite / filesystem failure.
 * - `EMBEDDER_ERROR`     — local embedder model failed.
 * - `INTERNAL`           — bug; surface, log, and bail.
 */
export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'CONFLICT',
  'IMMUTABLE',
  'CONFIG_ERROR',
  'SCRUBBED',
  'STORAGE_ERROR',
  'EMBEDDER_ERROR',
  'INTERNAL',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * Per-code human descriptions, used by the generated reference
 * doc (`docs/reference/error-codes.md`). Keep each entry to one
 * sentence describing *what the code means to a caller*, not
 * how the runtime detects it. The descriptions in the
 * `ERROR_CODES` block comment stay as the design rationale; this
 * map is the user-facing prose.
 *
 * The shape is `Record<ErrorCode, string>` so adding a new code
 * to `ERROR_CODES` is a type error here until a description is
 * provided — drift between the closed enum and the doc is
 * impossible.
 */
export const ERROR_CODE_DESCRIPTIONS: Record<ErrorCode, string> = {
  INVALID_INPUT:
    'The input was rejected by a schema or domain invariant. The caller should fix the request and retry.',
  NOT_FOUND:
    'The addressed memory, event, scope, or config key does not exist. The caller should re-resolve the identifier.',
  CONFLICT:
    'An optimistic-concurrency or supersedence race was detected. The caller should re-read state and try again.',
  IMMUTABLE:
    'The targeted field or config key is fixed for the lifetime of the server (for example `server.transport`). Restart with new configuration to change it.',
  CONFIG_ERROR:
    'A config write failed its per-key schema. The previous value remains in effect; correct the value and retry.',
  SCRUBBED:
    'A write was rejected because scrubbing removed all meaningful content. The caller should provide content that is not entirely sensitive.',
  STORAGE_ERROR:
    'SQLite or filesystem failure. The operation may be retried after the underlying issue is resolved (disk full, lock contention, permissions).',
  EMBEDDER_ERROR:
    'The local embedder model failed (load, inference, or shape mismatch). Vector-dependent operations are unavailable until it recovers.',
  INTERNAL:
    'An unexpected runtime failure (a bug). The error message is the only available signal; capture it and file an issue.',
};

/**
 * `MementoError` is the structured error payload carried by
 * `Result.err`. `details` is free-form, JSON-serialisable context
 * (e.g. the offending key, the Zod issue list); the runtime never
 * places non-serialisable values there so errors round-trip cleanly
 * through MCP transports.
 *
 * `hint` is an optional, human-readable, single-sentence
 * remediation. It is additive: callers that don't supply one
 * still emit a valid error. The CLI renderer prints it on a
 * separate line beneath the message; structured consumers
 * surface it however they prefer. Keep hints actionable
 * ("Run: npm rebuild better-sqlite3") rather than diagnostic
 * ("the binding failed to load"); the message already covers
 * the diagnostic.
 */
export const MementoErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(2048),
    details: z.unknown().optional(),
    hint: z.string().min(1).max(512).optional(),
  })
  .strict();
export type MementoError = z.infer<typeof MementoErrorSchema>;

/**
 * `Result<T, E>` is the universal envelope for fallible operations.
 *
 * Every public surface — CLI commands, MCP tools, repository
 * methods — returns a `Result` rather than throwing. Throwing is
 * reserved for programmer errors (invariants); user / I/O errors
 * are values. This makes error paths exhaustive at the type system
 * level and keeps the MCP transport boundary simple.
 */
export type Ok<T> = { ok: true; value: T };
export type Err<E = MementoError> = { ok: false; error: E };
export type Result<T, E = MementoError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E = MementoError>(error: E): Err<E> => ({
  ok: false,
  error,
});

/**
 * `ResultSchema` builds a Zod schema for `Result<T>` given a value
 * schema. Used by transport boundaries (MCP) to validate envelopes
 * coming back from the runtime.
 */
export const ResultSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: MementoErrorSchema }).strict(),
  ]);
