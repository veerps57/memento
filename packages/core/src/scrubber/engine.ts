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

import type { ScrubReport, ScrubberRule, ScrubberRuleSet } from '@psraghuveer/memento-schema';

export interface ScrubResult {
  readonly scrubbed: string;
  readonly report: ScrubReport;
}

interface Claim {
  readonly start: number;
  readonly end: number;
  readonly ruleId: string;
  readonly placeholder: string;
  readonly matchIndex: number;
}

export function applyRules(content: string, rules: ScrubberRuleSet): ScrubResult {
  const claims: Claim[] = [];
  const perRule = new Map<string, { count: number; severity: ScrubberRule['severity'] }>();

  for (const rule of rules) {
    // Schema guarantees `g`/`y` are not in `rule.flags`, so
    // appending `g` cannot produce a duplicate-flag SyntaxError.
    const re = new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
    let match: RegExpExecArray | null = re.exec(content);
    let perRuleIndex = 0;
    while (match !== null) {
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
