// Handler-time enforcement of the operator-tunable `safety.*`
// content / summary / tag caps from
// `packages/schema/src/config-keys.ts`.
//
// The Zod input schemas already pin a hard ceiling on these
// fields (`memory.write` rejects > 1 MiB content / > 64 KiB
// summary / > 1024 tags at the boundary, regardless of config).
// This helper sits *below* those ceilings and lets an operator
// tighten the policy without a schema change — typically to the
// 64 KiB / 2 KiB / 64 defaults shipped in the registry. Two
// layers cooperate: schema = "no more than this, ever"; config =
// "no more than this, by policy".
//
// We measure UTF-8 byte length rather than UTF-16 code units so
// the cap matches the on-disk shape of the content (SQLite stores
// UTF-8). For mostly-ASCII content the two are identical; the
// difference matters only for content with high-codepoint chars.

import {
  type MementoError,
  RESERVED_TAG_PREFIXES,
  type Result,
  type Scope,
  err,
  isReservedTag,
  ok,
} from '@psraghuveer/memento-schema';
import type { ConfigStore } from '../../config/index.js';

export interface SafetyCheckInput {
  readonly content: string;
  readonly summary: string | null;
  readonly tags: readonly string[];
  /**
   * Optional decision-rationale field. `memory.extract` carries
   * it as a top-level field; `memory.write` carries it inside
   * `kind.rationale` when `kind.type === 'decision'`. The caller
   * passes whatever is appropriate for its surface; the helper
   * applies the same content-byte cap because rationale is
   * content-shaped prose.
   */
  readonly rationale?: string | null;
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Validate a single write/extract input against the configured
 * safety caps. Returns `Ok(undefined)` on success, `Err` with a
 * descriptive `INVALID_INPUT` on the first violation. The check
 * runs *before* the scrubber and any storage work, so an
 * oversize input never reaches SQLite or the embedder.
 */
export function enforceSafetyCaps(
  op: string,
  input: SafetyCheckInput,
  configStore: ConfigStore,
  /**
   * Optional index for batch-error context (zero-based). When
   * present, it is woven into the message so the caller can tell
   * which item in `memory.write_many` (or `memory.extract`)
   * tripped the cap.
   */
  index?: number,
): Result<undefined> {
  const contentMax = configStore.get('safety.memoryContentMaxBytes');
  const summaryMax = configStore.get('safety.summaryMaxBytes');
  const tagMax = configStore.get('safety.tagMaxCount');
  const at = index !== undefined ? ` at items[${index}]` : '';

  const contentBytes = utf8Bytes(input.content);
  if (contentBytes > contentMax) {
    return err<MementoError>({
      code: 'INVALID_INPUT',
      message: `${op}: content${at} is ${contentBytes} bytes; exceeds safety.memoryContentMaxBytes (${contentMax})`,
      details: { limit: contentMax, received: contentBytes, field: 'content' },
    });
  }
  if (input.summary !== null) {
    const summaryBytes = utf8Bytes(input.summary);
    if (summaryBytes > summaryMax) {
      return err<MementoError>({
        code: 'INVALID_INPUT',
        message: `${op}: summary${at} is ${summaryBytes} bytes; exceeds safety.summaryMaxBytes (${summaryMax})`,
        details: { limit: summaryMax, received: summaryBytes, field: 'summary' },
      });
    }
  }
  if (input.rationale !== undefined && input.rationale !== null) {
    const rationaleBytes = utf8Bytes(input.rationale);
    if (rationaleBytes > contentMax) {
      return err<MementoError>({
        code: 'INVALID_INPUT',
        message: `${op}: rationale${at} is ${rationaleBytes} bytes; exceeds safety.memoryContentMaxBytes (${contentMax})`,
        details: { limit: contentMax, received: rationaleBytes, field: 'rationale' },
      });
    }
  }
  if (input.tags.length > tagMax) {
    return err<MementoError>({
      code: 'INVALID_INPUT',
      message: `${op}: ${input.tags.length} tags${at} exceeds safety.tagMaxCount (${tagMax})`,
      details: { limit: tagMax, received: input.tags.length, field: 'tags' },
    });
  }
  return ok(undefined);
}

/**
 * Reject any tag starting with a reserved system prefix
 * (`pack:`, etc — see {@link RESERVED_TAG_PREFIXES}). Called
 * from every user-write handler (`memory.write`,
 * `memory.write_many`, `memory.extract`); the pack-install path
 * deliberately bypasses this check because it owns the reserved
 * `pack:` namespace. Without this guard, a caller could forge a
 * pack-installed memory by adding a `pack:foo:1.0.0` tag on a
 * normal write — that would pollute the provenance model
 * ADR-0020 promises.
 */
export function assertNoReservedTags(
  op: string,
  tags: readonly string[],
  index?: number,
): Result<undefined> {
  const reserved = tags.filter(isReservedTag);
  if (reserved.length > 0) {
    const at = index !== undefined ? ` at items[${index}]` : '';
    return err<MementoError>({
      code: 'INVALID_INPUT',
      message: `${op}: tag${at} uses a reserved prefix (${RESERVED_TAG_PREFIXES.join(', ')}). Reserved prefixes are owned by system commands; user writes must not use them.`,
      details: { reservedPrefixes: [...RESERVED_TAG_PREFIXES], offending: reserved },
    });
  }
  return ok(undefined);
}

/**
 * Pull `rationale` out of a `MemoryKind` for the safety check.
 * Only the `decision` variant carries a rationale; every other
 * kind returns `null`. Centralised so callers don't repeat the
 * discriminator narrowing.
 */
export function rationaleFromKind(kind: {
  readonly type: string;
  readonly rationale?: string | null;
}): string | null {
  if (kind.type === 'decision') {
    return kind.rationale ?? null;
  }
  return null;
}

// Re-export `Scope` so callers don't need a second import line
// when they already pull from this module.
export type { Scope };
