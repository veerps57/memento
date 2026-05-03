// Per-kind conflict policies.
//
// `docs/architecture/conflict-detection.md` mandates that every
// `MemoryKind` has a registered policy: the structural test in
// `test/conflict/policies.test.ts` asserts the registry is total
// over `MEMORY_KIND_TYPES`, so adding a new kind without adding
// a policy fails CI before it can ship.
//
// A policy is a pure function over `(newMemory, candidate, config)`.
// "Pure" matters for the re-detection story: `memento conflicts
// scan` re-runs policies over the audit log, and we need the
// answer to be reproducible bit-for-bit. So no clocks, no random,
// no I/O — just the inputs.
//
// The policies are deliberately conservative. From the architecture
// doc: "Memento prefers a few high-confidence conflicts to many
// low-confidence ones". Each heuristic below is built to *miss*
// rather than *false-positive*. A miss is recoverable (the user
// can run `memento conflicts scan` later, or notice in retrieval
// and act); a false positive trains users to ignore conflicts.

import type { Memory, MemoryKindType } from '@psraghuveer/memento-schema';
import { CONFIG_KEYS } from '@psraghuveer/memento-schema';

/**
 * Result of a per-kind policy run. `evidence` is opaque at the
 * schema layer; each policy below documents the concrete shape
 * it emits so consumers (CLI, MCP) can render meaningful diffs.
 */
export type PolicyResult =
  | { readonly conflict: true; readonly evidence: unknown }
  | { readonly conflict: false };

/**
 * Configuration consumed by the policy registry. Nothing in v1
 * needs tuning knobs from outside, but the parameter slot exists
 * so a future `conflict.<kind>.*` config can flow in without
 * changing the call signature.
 */
export interface ConflictPolicyConfig {
  readonly factOverlapThreshold?: number;
}

export const DEFAULT_POLICY_CONFIG: Required<ConflictPolicyConfig> = {
  factOverlapThreshold: CONFIG_KEYS['conflict.fact.overlapThreshold'].default,
};

/** A single per-kind policy. */
export type ConflictPolicy = (
  next: Memory,
  candidate: Memory,
  config: Required<ConflictPolicyConfig>,
) => PolicyResult;

const NO_CONFLICT: PolicyResult = { conflict: false };

// — fact ——————————————————————————————————————————————————————
//
// Heuristic: detect a "stance flip". One memory denies what the
// other asserts (or vice versa) about the same subject.
//
// 1. Tokenise both contents into lowercased word stems of length
//    ≥ 4. Short tokens are too noisy to anchor a subject match.
// 2. Look for an asymmetric leading-negation marker — exactly one
//    of the two starts with `not ` / `no ` / `never ` (after
//    optional `that `). Symmetric negation (both negate) or no
//    negation in either is treated as agreement, not conflict.
// 3. Require ≥ `factOverlapThreshold` shared tokens. Below the
//    threshold the two are different topics; we err on silence.

const NEGATION_REGEX = /^\s*(?:that\s+)?(no|not|never)\b/i;

const factPolicy: ConflictPolicy = (next, candidate, config) => {
  const a = stems(next.content);
  const b = stems(candidate.content);
  const overlap = countShared(a, b);
  if (overlap < config.factOverlapThreshold) {
    return NO_CONFLICT;
  }
  const aNeg = NEGATION_REGEX.test(next.content);
  const bNeg = NEGATION_REGEX.test(candidate.content);
  if (aNeg === bNeg) {
    return NO_CONFLICT;
  }
  return {
    conflict: true,
    evidence: {
      kind: 'fact',
      reason: 'negation-flip-with-overlap',
      sharedTokens: overlap,
      negation: { next: aNeg, candidate: bNeg },
    },
  };
};

// — preference ————————————————————————————————————————————————
//
// Preferences are recorded as `<key>: <value>` (or `<key> = <value>`).
// Two preferences conflict iff they share a normalised key but
// declare different values. Free-form preferences without a
// detectable key never conflict — Memento prefers silence to
// guessing.

// Anchored greedy split on the first `:` or `=` of the first line.
// AGENTS.md documents the canonical preference / decision shape as
// `topic: value\n\nfree prose ...` — the topic line is first, prose
// follows. We anchor the match to the start of the FIRST LINE only:
// `[^:=\n]{1,80}` for the key (excluding newlines so the key cannot
// span lines), `[^\n]*` for the value (excluding newlines so prose
// after the topic line is ignored). No trailing `$` anchor — the
// engine should stop at end-of-line, not end-of-string. The captured
// groups are trimmed in `parseKeyValue`, so we do not need ambiguous
// `\s*` runs in the pattern itself — those caused polynomial
// backtracking on whitespace-heavy inputs (CodeQL js/polynomial-redos).
const PREFERENCE_KV_REGEX = /^\s*([^:=\n]{1,80})[:=]([^\n]*)/;

const preferencePolicy: ConflictPolicy = (next, candidate) => {
  const a = parseKeyValue(next.content);
  const b = parseKeyValue(candidate.content);
  if (a === null || b === null || a.key !== b.key) {
    return NO_CONFLICT;
  }
  if (a.value === b.value) {
    return NO_CONFLICT;
  }
  return {
    conflict: true,
    evidence: {
      kind: 'preference',
      key: a.key,
      values: { next: a.value, candidate: b.value },
    },
  };
};

// — decision ——————————————————————————————————————————————————
//
// Decisions get the same key/value heuristic as preferences:
// `we picked X for Y` style is unstructured and the project
// records decisions as `<context>: <choice>` in practice. The
// `MemoryKind.decision.rationale` field is *not* used for
// conflict detection — two decisions can share a context with
// different rationales and still agree on the choice.

const decisionPolicy: ConflictPolicy = (next, candidate) => {
  const a = parseKeyValue(next.content);
  const b = parseKeyValue(candidate.content);
  if (a === null || b === null || a.key !== b.key) {
    return NO_CONFLICT;
  }
  if (a.value === b.value) {
    return NO_CONFLICT;
  }
  return {
    conflict: true,
    evidence: {
      kind: 'decision',
      context: a.key,
      choices: { next: a.value, candidate: b.value },
    },
  };
};

// — todo ——————————————————————————————————————————————————————
//
// Two todos conflict iff their action text matches (case-
// insensitive, trimmed) and their `due` timestamps differ. A
// missing-vs-set due also counts — that's the common
// "I added a deadline to this todo, but the old one had none"
// case.

const todoPolicy: ConflictPolicy = (next, candidate) => {
  if (next.kind.type !== 'todo' || candidate.kind.type !== 'todo') {
    return NO_CONFLICT;
  }
  const aText = next.content.trim().toLowerCase();
  const bText = candidate.content.trim().toLowerCase();
  if (aText !== bText || aText.length === 0) {
    return NO_CONFLICT;
  }
  const aDue = next.kind.due;
  const bDue = candidate.kind.due;
  if (aDue === bDue || (aDue !== null && bDue !== null && aDue === bDue)) {
    return NO_CONFLICT;
  }
  return {
    conflict: true,
    evidence: {
      kind: 'todo',
      action: aText,
      due: { next: aDue, candidate: bDue },
    },
  };
};

// — snippet ———————————————————————————————————————————————————
//
// Snippets carry an optional `language`; we only fire when both
// have the same non-null language *and* their first non-empty
// line is structurally identical (a proxy for "same identifier
// / same signature") and the rest of the body diverges.

const snippetPolicy: ConflictPolicy = (next, candidate) => {
  if (next.kind.type !== 'snippet' || candidate.kind.type !== 'snippet') {
    return NO_CONFLICT;
  }
  if (
    next.kind.language === null ||
    candidate.kind.language === null ||
    next.kind.language !== candidate.kind.language
  ) {
    return NO_CONFLICT;
  }
  const aHead = firstNonEmptyLine(next.content);
  const bHead = firstNonEmptyLine(candidate.content);
  if (aHead === null || bHead === null || aHead !== bHead) {
    return NO_CONFLICT;
  }
  if (next.content === candidate.content) {
    return NO_CONFLICT;
  }
  return {
    conflict: true,
    evidence: {
      kind: 'snippet',
      language: next.kind.language,
      identifier: aHead,
    },
  };
};

/**
 * Registry of per-kind policies. Total over `MemoryKindType` —
 * the structural test asserts every kind has a key. The shape is
 * `Readonly<Record<…>>` rather than a `Map` so missing keys are a
 * compile-time error, not a runtime one.
 */
export const CONFLICT_POLICIES: Readonly<Record<MemoryKindType, ConflictPolicy>> = {
  fact: factPolicy,
  preference: preferencePolicy,
  decision: decisionPolicy,
  todo: todoPolicy,
  snippet: snippetPolicy,
};

/**
 * Run the registered policy for `next.kind`. Returns
 * `NO_CONFLICT` (without invoking the policy) when the candidate
 * is the same memory, has a different kind, or is the memory
 * being superseded — none of those are conflicts by definition.
 */
export function runPolicy(
  next: Memory,
  candidate: Memory,
  config: Required<ConflictPolicyConfig> = DEFAULT_POLICY_CONFIG,
): PolicyResult {
  if (next.id === candidate.id) {
    return NO_CONFLICT;
  }
  if (next.kind.type !== candidate.kind.type) {
    return NO_CONFLICT;
  }
  if (next.supersedes !== null && next.supersedes === candidate.id) {
    return NO_CONFLICT;
  }
  if (candidate.supersedes !== null && candidate.supersedes === next.id) {
    return NO_CONFLICT;
  }
  return CONFLICT_POLICIES[next.kind.type](next, candidate, config);
}

// — helpers ———————————————————————————————————————————————————

function parseKeyValue(content: string): { key: string; value: string } | null {
  const match = PREFERENCE_KV_REGEX.exec(content);
  if (match === null) {
    return null;
  }
  const key = match[1]?.trim().toLowerCase();
  const value = match[2]?.trim().toLowerCase();
  if (!key || !value) {
    return null;
  }
  return { key, value };
}

function stems(content: string): Set<string> {
  const out = new Set<string>();
  for (const tok of content.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length >= 4) {
      out.add(tok);
    }
  }
  return out;
}

function countShared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const tok of a) {
    if (b.has(tok)) {
      n += 1;
    }
  }
  return n;
}

function firstNonEmptyLine(content: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}
