import { z } from 'zod';
import { NonReservedTagSchema, type Tag, TagSchema, TimestampSchema } from './primitives.js';
import { ScopeSchema } from './scope.js';

/**
 * `memento-pack/v1` is the wire format for memento packs — the YAML
 * artefact a pack author writes and the parser consumes. The format
 * literal is the version handshake: a `v1` reader presented with a
 * `v2` artefact refuses with `INVALID_INPUT`; a `v1` reader presented
 * with a `v1` artefact carrying unknown top-level keys (a forward-compat
 * additive in v1.x) emits a warning and continues, matching the same
 * posture as `memento import`'s schema-version-skew handling
 * (ADR-0013 §schema-version-skew).
 *
 * See ADR-0020 for the full design and rationale.
 */
export const PACK_FORMAT_VERSION = 'memento-pack/v1' as const;

/**
 * Pack identifier regex. Lowercase kebab-case, 2 to 32 chars,
 * starting with a letter. The 32-char ceiling keeps the full
 * provenance tag (`pack:<id>:<version>`) inside the 64-char
 * `TagSchema` cap once a typical semver version is appended.
 */
const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Pack version regex. Semver MAJOR.MINOR.PATCH plus an optional
 * lowercase prerelease (e.g. `-rc.1`). Build metadata (`+...`) is
 * forbidden because `+` is outside the existing tag character set
 * and is ignored for ordering anyway. Capped at 24 chars so the full
 * provenance tag fits inside `TagSchema`'s 64-char ceiling.
 */
const PACK_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9.-]+)?$/;

export const PackIdSchema = z
  .string()
  .regex(PACK_ID_PATTERN, {
    message:
      'Pack id must be lowercase kebab-case, 2–32 chars, starting with a letter. Example: "ts-monorepo-pnpm".',
  })
  .describe('Pack identifier. Example: "ts-monorepo-pnpm".')
  .brand<'PackId'>();
export type PackId = z.infer<typeof PackIdSchema>;

export const PackVersionSchema = z
  .string()
  .regex(PACK_VERSION_PATTERN, {
    message:
      'Pack version must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease (lowercase, no build metadata). Examples: "1.2.0", "0.1.0-rc.1".',
  })
  .max(24, { message: 'Pack version exceeds 24 characters.' })
  .describe('Pack semver version. Examples: "1.0.0", "0.2.1-rc.1".')
  .brand<'PackVersion'>();
export type PackVersion = z.infer<typeof PackVersionSchema>;

/**
 * Per-memory base fields shared across every pack memory variant.
 * Mirrors the user-supplied subset of `Memory` — id, createdAt,
 * status, owner, scope, and lifecycle metadata are stamped at
 * install time and never appear in a manifest.
 *
 * Tags are validated through {@link NonReservedTagSchema}: pack
 * authors do not own the `pack:` namespace; the install path
 * appends the canonical provenance tag automatically.
 */
const PackMemoryBaseFields = {
  content: z.string().min(1),
  summary: z.string().min(1).nullable().optional(),
  tags: z.array(NonReservedTagSchema).optional(),
  pinned: z.boolean().optional(),
  sensitive: z.boolean().optional(),
} as const;

/**
 * Discriminated union of pack memory variants. Each variant carries
 * the kind-specific fields its `MemoryKind` requires (`rationale`
 * for decisions, `due` for todos, `language` for snippets) — the
 * names and shapes match the live {@link MemoryKindSchema}.
 *
 * `.strict()` rejects unknown per-item keys so a typo (e.g.
 * `langauge` for `language`) surfaces at parse time rather than
 * silently dropping at install.
 */
export const PackMemoryItemSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fact'),
      ...PackMemoryBaseFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal('preference'),
      ...PackMemoryBaseFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal('decision'),
      rationale: z.string().min(1).nullable().optional(),
      ...PackMemoryBaseFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal('todo'),
      due: TimestampSchema.nullable().optional(),
      ...PackMemoryBaseFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal('snippet'),
      language: z.string().min(1).max(64).nullable().optional(),
      ...PackMemoryBaseFields,
    })
    .strict(),
]);
export type PackMemoryItem = z.infer<typeof PackMemoryItemSchema>;

/**
 * Pack-wide defaults applied to every memory unless overridden
 * per-item. Tags supplied here are merged into each memory's tags;
 * the install path additionally appends the canonical provenance
 * tag.
 */
export const PackDefaultsSchema = z
  .object({
    scope: ScopeSchema.optional(),
    pinned: z.boolean().optional(),
    tags: z.array(NonReservedTagSchema).optional(),
  })
  .strict();
export type PackDefaults = z.infer<typeof PackDefaultsSchema>;

/**
 * Top-level pack manifest. `.strict()` so that unknown top-level
 * keys are visible — the parser layer detects them and emits a
 * warning before stripping them, matching the forward-compat
 * posture described in ADR-0020.
 *
 * Authors omit `defaults` to use system defaults
 * (scope=`{type: 'global'}`, pinned=false, no extra tags). The
 * install path's scope override (`pack install --scope ...`) takes
 * precedence over `defaults.scope`.
 */
export const PackManifestSchema = z
  .object({
    format: z.literal(PACK_FORMAT_VERSION),
    id: PackIdSchema,
    version: PackVersionSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    author: z.string().max(200).optional(),
    license: z.string().max(64).optional(),
    homepage: z.string().url().max(500).optional(),
    tags: z.array(NonReservedTagSchema).max(20).optional(),
    defaults: PackDefaultsSchema.optional(),
    memories: z.array(PackMemoryItemSchema).min(1),
  })
  .strict();
export type PackManifest = z.infer<typeof PackManifestSchema>;

/**
 * Stable separator between `<id>` and `<version>` in the canonical
 * pack provenance tag. Defined as a constant so the format is one
 * source of truth for `formatPackTag` / `parsePackTag` /
 * `packTagPrefix`.
 *
 * `:` is chosen because `@` is outside the existing tag character
 * set and `:` is already the conventional namespace separator
 * there. See ADR-0020 §Format for the rationale.
 */
const PACK_TAG_PREFIX = 'pack:';
const PACK_TAG_VERSION_SEPARATOR = ':';

/**
 * Canonical provenance tag for a pack-installed memory:
 * `pack:<id>:<version>`. Returns a parsed {@link Tag} so the result
 * is type-compatible with anywhere `Tag` is expected. Uses the bare
 * {@link TagSchema} (not {@link NonReservedTagSchema}) because this
 * function is the canonical writer of the reserved namespace.
 */
export function formatPackTag(id: PackId, version: PackVersion): Tag {
  return TagSchema.parse(`${PACK_TAG_PREFIX}${id}${PACK_TAG_VERSION_SEPARATOR}${version}`);
}

/**
 * Inverse of {@link formatPackTag}. Returns `null` for any tag that
 * is not a canonical pack provenance tag — callers may use this to
 * filter / group memories by their originating pack without
 * round-tripping through schema parsing.
 *
 * Note: the returned `id` and `version` are **strings**, not branded
 * types, because the function operates on opaque tag strings (which
 * may originate from a database row, not a freshly parsed schema).
 * Callers that need branded types can re-parse via
 * {@link PackIdSchema} and {@link PackVersionSchema}.
 */
export function parsePackTag(tag: string): { id: string; version: string } | null {
  if (!tag.startsWith(PACK_TAG_PREFIX)) return null;
  const remainder = tag.slice(PACK_TAG_PREFIX.length);
  const sepIndex = remainder.indexOf(PACK_TAG_VERSION_SEPARATOR);
  if (sepIndex < 0) return null;
  const id = remainder.slice(0, sepIndex);
  const version = remainder.slice(sepIndex + 1);
  if (!PACK_ID_PATTERN.test(id)) return null;
  if (!PACK_VERSION_PATTERN.test(version)) return null;
  if (version.length > 24) return null;
  return { id, version };
}

/**
 * Returns the prefix used to filter every version of a given pack
 * (`pack:<id>:`). Callers feed it into a tag-prefix list filter to
 * implement `pack uninstall --all-versions`.
 */
export function packTagPrefix(id: PackId): string {
  return `${PACK_TAG_PREFIX}${id}${PACK_TAG_VERSION_SEPARATOR}`;
}
