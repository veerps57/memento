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

The scrubber runs **on every write**, before persistence, inside the same transaction. There is no path to write a memory that bypasses the scrubber except by setting `scrubber.enabled = false` (which logs at WARN every server start).

```text
memory.write → validate input → scrub → persist (memories + memory_events)
                                  │
                                  └─▶ scrubReport → memory_events.scrubReport
```

The `MemoryEvent.scrubReport` records what the scrubber did: which rules matched, how many replacements were made, and the byte-offsets of the matches in the pre-scrub content. The pre-scrub content itself is **not** stored, anywhere. The point is to not have it on disk.

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

The default rule set ships in `@psraghuveer/memento-core/scrubber/defaults.ts` and covers:

- Generic API keys (high-entropy strings prefixed by common conventions: `sk-`, `xoxb-`, `ghp_`, etc.).
- AWS access keys (`AKIA[0-9A-Z]{16}`) and secret keys (heuristic).
- JWT-shaped tokens (`eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`).
- Email addresses (`<email-redacted>` placeholder; opt-out via config).
- IPv4 / IPv6 addresses (opt-out by default; `severity: 'low'`).
- Conventional secret-bearing variable assignments (`PASSWORD=...`, `SECRET=...`, etc.).

The defaults are intentionally **biased toward false positives**. False positives are visible and recoverable (the scrubReport shows what was redacted; the user can edit the rule); false negatives leak secrets to disk, which is irrecoverable.

## Custom rules

Users add rules in their config:

```yaml
scrubber:
  rules:
    - id: company-internal-host
      description: Mask internal hostnames
      pattern: "(?i)\\b[a-z0-9-]+\\.internal\\.example\\.com\\b"
      placeholder: "<internal-host>"
      severity: low
    # User rules are appended after the defaults by default;
    # a top-level `scrubber.replaceDefaults: true` lets advanced
    # users start from an empty rule list.
```

Rules are validated by Zod at config load. Invalid regexes (RE2-incompatible, including unbounded backreferences and lookaheads) are rejected at load time, not at write time. This is principle 1 (First principles): the cost of an invalid rule should be paid by the user once, not by every subsequent write.

## Engine

The scrubber uses the Node `RegExp` engine but restricts patterns to RE2-compatible syntax to avoid catastrophic backtracking. The validation step rejects unbounded lookarounds and quantifier nesting that could produce ReDoS. A future swap to a true RE2 binding is a localized change.

A per-write timeout (`scrubber.timeoutMs`, default `100`) bounds total scrub time. Hitting the timeout fails the write with a structured error pointing at the offending rule (the last rule that started before the timeout). This is preferable to dropping the rule silently.

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
