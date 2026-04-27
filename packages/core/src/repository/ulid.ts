// ULID generator.
//
// Memento ids are Crockford-base32 ULIDs (26 chars) per
// `@psraghuveer/memento-schema`. We inline a small generator rather than
// take a dependency: ULIDs are a fixed format with one published
// algorithm, the implementation is ~50 lines, and the tradeoff
// between an upstream npm package and inlined code in our repo
// is in our favour for something this stable.
//
// Format (per the Crockford / ULID spec):
//   - 48-bit big-endian timestamp (ms since epoch)            10 chars
//   - 80-bit randomness                                       16 chars
//
// The alphabet is Crockford base32 minus `I`, `L`, `O`, `U` so
// strings cannot be confused for digits or each other.
//
// Properties this generator preserves:
//   - lexicographic ordering by creation time across processes;
//   - monotonicity within a single process when the clock does not
//     advance (the last 80 random bits are incremented by 1 to
//     guarantee strict order without re-reading the clock);
//   - cryptographically-strong randomness (Web Crypto / Node
//     `crypto.getRandomValues`).
//
// Monotonic-within-millisecond is important because we use ULIDs
// for event-stream ordering. Without it, two events emitted in the
// same millisecond could sort in arbitrary order on read, which
// would break "last event wins" reasoning.

import { webcrypto } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

interface UlidState {
  lastTimeMs: number;
  lastRandom: Uint8Array;
}

const sharedState: UlidState = {
  lastTimeMs: -1,
  lastRandom: new Uint8Array(10),
};

/**
 * Returns a freshly-generated ULID string. Safe to call concurrently
 * within a single Node process: the monotonic-within-millisecond
 * fast path uses the module-scoped {@link sharedState} guarded by
 * the JavaScript run-to-completion model.
 *
 * Test code that needs determinism should pass an explicit
 * `idFactory` to the repository instead of stubbing this function.
 */
export function ulid(nowMs: number = Date.now()): string {
  const time = encodeTime(nowMs);
  const rand = nextRandom(nowMs);
  return time + encodeRandom(rand);
}

function encodeTime(timeMs: number): string {
  if (timeMs < 0 || timeMs > 0xffff_ffff_ffff) {
    throw new RangeError(`ulid time out of range: ${timeMs}`);
  }
  let value = timeMs;
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    out[i] = ALPHABET[value % 32] as string;
    value = Math.floor(value / 32);
  }
  return out.join('');
}

function nextRandom(timeMs: number): Uint8Array {
  if (timeMs === sharedState.lastTimeMs) {
    // Same millisecond: increment the last random value to keep
    // strict monotonicity. Overflow into the time field is the
    // documented spec behaviour but unreachable in practice
    // (would require >2^80 ULIDs in a single ms).
    const next = new Uint8Array(sharedState.lastRandom);
    incrementBytes(next);
    sharedState.lastRandom = next;
    return next;
  }
  const fresh = new Uint8Array(10);
  webcrypto.getRandomValues(fresh);
  sharedState.lastTimeMs = timeMs;
  sharedState.lastRandom = fresh;
  return fresh;
}

function incrementBytes(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    const next = ((bytes[i] ?? 0) + 1) & 0xff;
    bytes[i] = next;
    if (next !== 0) {
      return;
    }
  }
  // All 10 bytes wrapped — the spec says clamp; we throw because
  // it should never happen with strong randomness.
  throw new Error('ulid randomness overflow');
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits → 16 base32 chars. We treat the bytes as a big-endian
  // bit-stream and pull 5 bits at a time from the most-significant
  // end. Building from a BigInt is the simplest correct approach.
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  const out = new Array<string>(RAND_LEN);
  for (let i = RAND_LEN - 1; i >= 0; i -= 1) {
    out[i] = ALPHABET[Number(value & 31n)] as string;
    value >>= 5n;
  }
  return out.join('');
}
