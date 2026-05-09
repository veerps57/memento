import { z } from 'zod';

/**
 * Branded primitive types for `@psraghuveer/memento-schema`.
 *
 * Memento uses Zod brands to give nominal typing to values that are
 * structurally `string` but semantically distinct (a `MemoryId` is not
 * interchangeable with a `Tag`). This file defines the brand schemas
 * and re-exports the inferred TypeScript types.
 *
 * Design notes:
 *
 * - All identifiers are ULIDs: 26-character Crockford base32 strings
 *   that sort lexicographically by creation time. The regex below
 *   matches the canonical alphabet (excluding `I`, `L`, `O`, `U`).
 * - `Timestamp` is an ISO-8601 UTC string with millisecond precision
 *   and the `Z` suffix. Storing strings (rather than `Date`) keeps
 *   memories serialisable without a custom JSON reviver and removes
 *   ambiguity about timezone.
 * - `Tag` is normalised at parse time: trimmed and lowercased. Tags
 *   are deduped by callers (the schema operates on a single value).
 *   Tags reject leading/trailing whitespace after normalisation and
 *   forbid embedded whitespace; they may contain ASCII letters,
 *   digits, `-`, `_`, `/`, `.`, and `:`.
 * - `AbsolutePath` is platform-agnostic at the schema layer: it
 *   accepts POSIX absolute paths (`/...`) and Windows drive paths
 *   (`C:\...`). Path canonicalisation happens in the resolver, not
 *   at the type boundary.
 * - `RepoRemote` is the canonical, lowercased `host/owner/name` form
 *   produced by the repo resolver — never a raw git URL. Storing the
 *   canonical form avoids fan-out keys for the same logical repo.
 */

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;
const POSIX_ABSOLUTE_PATTERN = /^\//;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const REPO_REMOTE_PATTERN = /^[a-z0-9.-]+\/[a-z0-9._-]+\/[a-z0-9._-]+$/;

// All four ULID-shaped fields share the same regex; the `message`
// option attaches a uniformly helpful error so a bad input shows
// callers the expected format instead of a bare "Invalid". The
// previous `scope.id: Invalid` message left no clue about the
// 26-char Crockford-base32 requirement.
const ULID_ERROR_MESSAGE =
  'must be a 26-character Crockford-base32 ULID (e.g. "01HYXZ1A2B3C4D5E6F7G8H9J0K")';

export const MemoryIdSchema = z
  .string()
  .regex(ULID_PATTERN, { message: ULID_ERROR_MESSAGE })
  .describe('A 26-character ULID string (Crockford base32). Example: "01HYXZ1A2B3C4D5E6F7G8H9J0K".')
  .brand<'MemoryId'>();
export type MemoryId = z.infer<typeof MemoryIdSchema>;

export const EventIdSchema = z
  .string()
  .regex(ULID_PATTERN, { message: ULID_ERROR_MESSAGE })
  .describe('A 26-character ULID string identifying an event.')
  .brand<'EventId'>();
export type EventId = z.infer<typeof EventIdSchema>;

export const SessionIdSchema = z
  .string()
  .regex(ULID_PATTERN, { message: ULID_ERROR_MESSAGE })
  .describe('A 26-character ULID string identifying a session.')
  .brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionIdSchema>;

export const ConflictIdSchema = z
  .string()
  .regex(ULID_PATTERN, { message: ULID_ERROR_MESSAGE })
  .describe('A 26-character ULID string identifying a conflict.')
  .brand<'ConflictId'>();
export type ConflictId = z.infer<typeof ConflictIdSchema>;

export const TimestampSchema = z
  .string()
  .regex(ISO_TIMESTAMP_PATTERN)
  .describe(
    'ISO-8601 UTC timestamp with millisecond precision. Example: "2025-01-15T09:30:00.000Z".',
  )
  .brand<'Timestamp'>();
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * Normalises a candidate tag (trim + lowercase) before validating it
 * against the tag character set. Returning the parsed brand allows
 * callers to use the schema as both a validator and a normaliser.
 */
export const TagSchema = z
  .string()
  .describe(
    'A tag string (1–64 chars). Trimmed and lowercased on ingest. Allowed characters: a-z, 0-9, "-", "_", "/", ".", ":". Examples: "project:memento", "lang-typescript", "config".',
  )
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().min(1).max(64).regex(TAG_PATTERN))
  .brand<'Tag'>();
export type Tag = z.infer<typeof TagSchema>;

export const AbsolutePathSchema = z
  .string()
  .min(1)
  .describe(
    'An absolute filesystem path (POSIX or Windows). Examples: "/home/user/project", "C:\\Users\\user\\project".',
  )
  .refine((value) => POSIX_ABSOLUTE_PATTERN.test(value) || WINDOWS_ABSOLUTE_PATTERN.test(value), {
    message: 'AbsolutePath must be a POSIX or Windows absolute path',
  })
  .brand<'AbsolutePath'>();
export type AbsolutePath = z.infer<typeof AbsolutePathSchema>;

export const RepoRemoteSchema = z
  .string()
  .regex(REPO_REMOTE_PATTERN)
  .describe(
    'Canonical lowercased "host/owner/name" form of a git remote. Example: "github.com/acme/my-repo".',
  )
  .brand<'RepoRemote'>();
export type RepoRemote = z.infer<typeof RepoRemoteSchema>;

/**
 * Tag prefixes reserved for system-managed provenance. User-authored
 * writes (`memory.write`, `memory.write_many`, `memory.extract`)
 * reject any tag starting with one of these prefixes. The internal
 * write paths that own the namespace (e.g. pack install) bypass the
 * rejection by threading a write-source flag through the command
 * context. Reserved prefixes are a Rule 12 invariant — hardcoded,
 * not configurable.
 *
 * See ADR-0020 (memento packs) for the `pack:` prefix; future
 * provenance prefixes append here.
 */
export const RESERVED_TAG_PREFIXES = ['pack:'] as const;
export type ReservedTagPrefix = (typeof RESERVED_TAG_PREFIXES)[number];

/**
 * Returns true if the candidate tag begins with any reserved prefix.
 * Operates on raw strings as well as branded Tags; use it before a
 * write that should not own the reserved namespace.
 */
export function isReservedTag(tag: string): boolean {
  return RESERVED_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

/**
 * Tag schema that rejects values starting with any reserved prefix.
 * Use anywhere a tag is supplied through a user-authored path
 * (manifest authoring, command inputs); the internal write paths
 * that own the reserved namespace use the bare {@link TagSchema}.
 *
 * The refinement runs after {@link TagSchema}'s normalise+validate,
 * so the prefix check sees the lowercased canonical form.
 */
export const NonReservedTagSchema = TagSchema.refine((tag) => !isReservedTag(tag), {
  message: `Tag uses a reserved prefix (${RESERVED_TAG_PREFIXES.join(', ')})`,
});
export type NonReservedTag = z.infer<typeof NonReservedTagSchema>;
