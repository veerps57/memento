# Architecture: Scrubber

This document describes the scrubber: the component that redacts secrets and reduces PII at the boundary between input and storage.

## Why a scrubber

Memory written by an AI agent often contains things the user did not mean to persist:

- API keys pasted into prompts.
- Bearer tokens echoed by curl examples.
- Internal email addresses, hostnames, and identifiers.
- Customer data from logs or tracebacks.

A memory layer that stores these things faithfully is a liability. The scrubber's job is to make it harder to accidentally persist them, while making it visible when redaction happened so legitimate data is not silently lost.

## Where it runs

The scrubber runs **on every write**, before persistence, inside the same transaction. There is no path to write a memory that bypasses the scrubber except by setting `scrubber.enabled = false`. That setting (and the `scrubber.rules` set) is **immutable at runtime** — it can only be flipped at server start via configuration overrides, never via a runtime `config.set`. This is deliberate: a prompt-injected assistant calling `config.set scrubber.enabled false` before writing a secret would otherwise be a one-shot bypass of the entire defence.

```text
memory.write → validate input → scrub → persist (memories + memory_events)
                                  │
                                  └─▶ scrubReport → memory_events.scrubReport
```

Three free-text fields are scrubbed on every write: `content`, `summary`, and (for `decision`-kind memories) `kind.rationale`. Earlier the scrubber operated on `content` only — an LLM auto-generating a summary from raw content trivially round-tripped the secret into the persisted summary. The merged `scrubReport` aggregates per-rule match counts across all three fields; `byteOffsets` are recorded for `content` only.

The `MemoryEvent.scrubReport` records what the scrubber did: which rules matched, how many replacements were made, and the byte-offsets of the matches in the pre-scrub content. The pre-scrub content itself is **not** stored, anywhere. The point is to not have it on disk.

**Imports run the scrubber too.** `memento import` re-runs the scrubber over every imported memory's content / summary / rationale using the **importer's** current rule set, regardless of what the source artefact already had. An artefact authored on a host with weaker scrubber rules has its secrets re-redacted on the way in. See ADR-0019.

## Rules

A scrubber rule is:

```ts
interface ScrubberRule {
  id: string; // stable identifier; appears in scrubReport
  description: string; // human-readable; surfaced in `memento doctor`
  pattern: string; // RE2-compatible regex
  flags?: string; // e.g., 'i'
  placeholder: string; // template; supports {{rule.id}}, {{match.index}}
  severity: "low" | "medium" | "high";
}
```

Rules are evaluated in order. The first match for a region wins; subsequent rules cannot re-match an already-scrubbed region. Order matters and is part of the configuration.

The default rule set is the single canonical list in `@psraghuveer/memento-schema` (re-exported from `@psraghuveer/memento-core/scrubber/defaults.ts` so consumers can import without depending on the schema package directly). It covers:

- Generic API keys (high-entropy strings prefixed by common conventions: `sk-`, `xoxb-`, `ghp_`, etc.).
- AWS access keys (`AKIA[0-9A-Z]{16}` / `ASIA…`).
- JWT-shaped tokens — `eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{4,}`. The middle-segment minimum is 2 chars so unsigned JWTs whose payload encodes the empty object `{}` (`e30`) are caught.
- PEM-encoded private-key blocks (`-----BEGIN [A-Z ]+PRIVATE KEY-----…-----END …-----`).
- HTTP `Authorization: Bearer <token>` headers (word-boundary anchored so prose containing "bear"/"bearer" mid-word does not match).
- Email addresses — `[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`. The domain is split into non-overlapping label classes so `a.a.a.a.a@a.a.a.a.a` does not trigger quadratic backtracking.
- Conventional secret-bearing variable assignments (`PASSWORD=...`, `SECRET=...`, `API_KEY=…`, `TOKEN=…`).

The defaults are intentionally **biased toward false positives**. False positives are visible and recoverable (the scrubReport shows what was redacted; the user can edit the rule); false negatives leak secrets to disk, which is irrecoverable.

## Custom rules

`scrubber.rules` is the full ordered rule list — setting it replaces the default set entirely. To extend rather than replace, add the new rules to a copy of `DEFAULT_SCRUBBER_RULES` (re-exported from `@psraghuveer/memento-core/scrubber/defaults`) and pass the merged list. Because both `scrubber.enabled` and `scrubber.rules` are immutable at runtime (pinned at server start so a prompt-injected `config.set` cannot weaken redaction before writing a secret), overrides land via `configOverrides` to `createMementoApp` for library hosts, or via `memento config set scrubber.rules '<json>'` against a stopped server's persisted layer for the CLI.

A library host extending the defaults looks like:

```ts
import { createMementoApp } from "@psraghuveer/memento-core";
import { DEFAULT_SCRUBBER_RULES } from "@psraghuveer/memento-core/scrubber/defaults";

const app = await createMementoApp({
  dbPath: "/abs/path/to/memento.db",
  configOverrides: {
    "scrubber.rules": [
      ...DEFAULT_SCRUBBER_RULES,
      {
        id: "company-internal-host",
        description: "Mask internal hostnames",
        pattern: "(?i)\\b[a-z0-9-]+\\.internal\\.example\\.com\\b",
        placeholder: "<internal-host>",
        severity: "low",
      },
    ],
  },
});
```

Rules are validated by Zod at startup. Invalid regexes (RE2-incompatible, including unbounded backreferences and lookaheads) are rejected then, not at write time. This is principle 1 (First principles): the cost of an invalid rule should be paid by the operator once, not by every subsequent write.

## Engine

The scrubber uses the Node `RegExp` engine but restricts patterns to RE2-compatible syntax to avoid catastrophic backtracking. The validation step rejects unbounded lookarounds and quantifier nesting that could produce ReDoS. A future swap to a true RE2 binding is a localized change.

A per-rule wallclock budget (`scrubber.engineBudgetMs`, default `50`) bounds each rule's runtime. Between iterations of `re.exec`, the engine checks if the rule has accumulated more than the budget; if so, the rule is aborted and treated as "no match for this rule on this write". The budget cannot interrupt an in-progress single match attempt — JavaScript's `RegExp` engine is atomic and synchronous — so the structural defence against ReDoS is the rule set itself: every default rule is engineered for linear-time matching, and `scrubber.rules` is immutable at runtime so only operator-vetted overrides are loaded. The budget catches the "rule that produces many slow matches" pattern that the structural defence does not bound.

## Disabling

`scrubber.enabled = false` disables scrubbing entirely. The setting:

- Logs a WARN at every server start.
- Reported by `memento doctor`.
- Is appended to the audit metadata of every subsequent `created`/`updated` event for the duration of the disable.

There is intentionally no "scrub for some kinds, not others" knob. The control surface is per-rule (which is sufficient) and per-server (which is the safety hatch). Adding more granularity is easy later if a real use case demands it.

## What this enables

- **Hard-to-accidentally-persist secrets.** The default rules catch the common shapes.
- **Visibility into redaction.** scrubReport tells you what was redacted and why.
- **User-extensible coverage.** Custom rules cover org-specific secrets without code changes.

## What this deliberately omits

- **ML-based PII detection.** Heuristics first. ML detection is a future extension via the existing rule interface.
- **Decryption / unwrap of envelopes.** Out of scope.
- **Selective unscrub.** Once redacted at write time, the original is gone — by design.
