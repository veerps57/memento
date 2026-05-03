// Pure scrubber engine.
//
// Contract: `applyRules(content, rules) → { scrubbed, report }` is a
// total, side-effect-free function over a UTF-16 string and a
// schema-validated rule set. The repository calls this once per
// write, inside the same transaction that records the resulting
// `scrubReport` on the `created` (or `superseded → created`) event.
//
// Algorithm:
//
//   1. For each rule in declared order, find every match in the
//      full pre-scrub content using Node's `RegExp` engine with
//      `g` appended (the schema rejects user-supplied `g`/`y`
//      because the engine controls iteration).
//   2. Drop matches that overlap a span already claimed by an
//      earlier rule. This is "first match for a region wins;
//      subsequent rules cannot re-match an already-scrubbed
//      region" from `docs/architecture/scrubber.md`.
//   3. Sort the surviving claims left-to-right and materialise the
//      scrubbed output by interleaving unchanged slices with the
//      rendered placeholder for each claim.
//
// The byte-offset list in the report is in pre-scrub coordinates
// (the schema is explicit about this) and is sorted so a reviewer
// can re-run the rules on a fresh sample and compare deterministically.
//
// ReDoS budget. `applyRules` accepts an optional per-rule wallclock
// budget. Between iterations of `re.exec`, the engine compares the
// elapsed time against the cap and aborts the rule if it has
// overshot — treating the truncated match list as final. This
// catches the common "rule that produces many slow matches"
// pattern. It cannot interrupt an in-progress `re.exec` call:
// JavaScript's regex engine is atomic and synchronous, so a single
// catastrophic match attempt still runs to completion. Defence
// against that is structural — the default rule set is rewritten
// to be ReDoS-safe and `scrubber.rules` is operator-pinned at
// startup (immutable in the config registry).

import type { ScrubReport, ScrubberRule, ScrubberRuleSet } from '@psraghuveer/memento-schema';

export interface ScrubResult {
  readonly scrubbed: string;
  readonly report: ScrubReport;
}

export interface ApplyRulesOptions {
  /**
   * Per-rule wallclock budget in milliseconds. When set, the
   * engine aborts a rule once `Date.now() - ruleStart` exceeds
   * the cap; remaining matches for that rule are skipped.
   * Defaults to no budget (unbounded).
   */
  readonly engineBudgetMs?: number;
  /**
   * Receives a notice when a rule was aborted by the budget.
   * The host can log it to the audit channel; the scrubber
   * itself does not emit telemetry to keep this module pure.
   */
  readonly onBudgetExceeded?: (ruleId: string, elapsedMs: number) => void;
}

interface Claim {
  readonly start: number;
  readonly end: number;
  readonly ruleId: string;
  readonly placeholder: string;
  readonly matchIndex: number;
}

export function applyRules(
  content: string,
  rules: ScrubberRuleSet,
  options: ApplyRulesOptions = {},
): ScrubResult {
  const claims: Claim[] = [];
  const perRule = new Map<string, { count: number; severity: ScrubberRule['severity'] }>();
  const budgetMs = options.engineBudgetMs;

  for (const rule of rules) {
    // Schema guarantees `g`/`y` are not in `rule.flags`, so
    // appending `g` cannot produce a duplicate-flag SyntaxError.
    const re = new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
    const ruleStart = budgetMs !== undefined ? Date.now() : 0;
    let match: RegExpExecArray | null = re.exec(content);
    let perRuleIndex = 0;
    while (match !== null) {
      // Per-rule budget gate. Checked between iterations because
      // `re.exec` itself is uninterruptible — see module header.
      if (budgetMs !== undefined) {
        const elapsed = Date.now() - ruleStart;
        if (elapsed > budgetMs) {
          options.onBudgetExceeded?.(rule.id, elapsed);
          break;
        }
      }
      const start = match.index;
      const end = start + match[0].length;
      // Zero-length matches would loop forever and contribute
      // nothing observable; skip past them.
      if (end === start) {
        re.lastIndex = start + 1;
        match = re.exec(content);
        continue;
      }
      // First-match-wins: drop if this match overlaps any prior claim.
      if (claims.some((c) => start < c.end && end > c.start)) {
        match = re.exec(content);
        continue;
      }
      perRuleIndex += 1;
      claims.push({
        start,
        end,
        ruleId: rule.id,
        placeholder: rule.placeholder,
        matchIndex: perRuleIndex,
      });
      match = re.exec(content);
    }
    if (perRuleIndex > 0) {
      perRule.set(rule.id, { count: perRuleIndex, severity: rule.severity });
    }
  }

  claims.sort((a, b) => a.start - b.start);

  let scrubbed = '';
  let cursor = 0;
  for (const claim of claims) {
    scrubbed += content.slice(cursor, claim.start);
    scrubbed += renderPlaceholder(claim.placeholder, claim.ruleId, claim.matchIndex);
    cursor = claim.end;
  }
  scrubbed += content.slice(cursor);

  const report: ScrubReport = {
    rules: Array.from(perRule, ([ruleId, v]) => ({
      ruleId,
      matches: v.count,
      severity: v.severity,
    })),
    byteOffsets: claims.map((c) => [c.start, c.end] as [number, number]),
  };

  return { scrubbed, report };
}

/**
 * Render a placeholder template per the schema-validated grammar:
 *
 * - `{{rule.id}}`     → the matching rule's id.
 * - `{{match.index}}` → 1-based per-rule match counter.
 * - `{{{{` / `}}}}`   → literal `{{` / `}}`.
 *
 * A single left-to-right pass is required because the literal
 * escape `}}}}` and the closing `}}` of a substitution are not
 * distinguishable by independent global replacements — a naive
 * `replaceAll('}}}}')` would happily eat the trailing `}}` of an
 * adjacent `{{rule.id}}`. The tokeniser greedily matches the four
 * shapes the schema permits, defaulting to a single-character
 * copy for everything else.
 */
function renderPlaceholder(template: string, ruleId: string, matchIndex: number): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    if (template.startsWith('{{{{', i)) {
      out += '{{';
      i += 4;
    } else if (template.startsWith('}}}}', i)) {
      out += '}}';
      i += 4;
    } else if (template.startsWith('{{rule.id}}', i)) {
      out += ruleId;
      i += 11;
    } else if (template.startsWith('{{match.index}}', i)) {
      out += String(matchIndex);
      i += 15;
    } else {
      out += template[i];
      i += 1;
    }
  }
  return out;
}
