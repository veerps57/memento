import { z } from 'zod';
import { ScrubberRuleSeveritySchema } from './event.js';

/**
 * `ScrubberRule` is the user-facing description of a single
 * redaction rule. The full design is in
 * [`docs/architecture/scrubber.md`](../../../docs/architecture/scrubber.md);
 * the short version:
 *
 * - `id` is the stable identifier that appears in `ScrubReport`.
 *   It must be unique across the active rule set; the loader
 *   enforces that, but the schema enforces shape and length.
 * - `description` is human-readable text shown in `memento doctor`.
 * - `pattern` is an RE2-compatible regex source string. Schema
 *   validation rejects empty patterns and patterns Node's `RegExp`
 *   refuses to compile; the loader additionally rejects RE2-
 *   incompatible features (lookarounds, unbounded backreferences).
 * - `flags` follow the standard JavaScript regex flag alphabet.
 *   `g` is forbidden because the engine controls the iteration
 *   strategy itself; sticky/`y` is also forbidden for the same
 *   reason.
 * - `placeholder` is the replacement template. `{{rule.id}}` and
 *   `{{match.index}}` are the supported substitutions; literal
 *   `{{` is escaped as `{{{{`.
 * - `severity` is informational metadata (`low | medium | high`).
 *
 * Validating these at config load instead of at write time is
 * deliberate: the cost of an invalid rule is paid once by the
 * user, not by every subsequent write (per ADR 0002 and the
 * scrubber design doc).
 */
export const ScrubberRuleIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/, {
    message: 'scrubber rule id must be lowercase, start with [a-z0-9], and use only [a-z0-9._:/-]',
  });

const PlaceholderTemplateSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (s) => {
      // Reject any single `{` or `}` that is not part of a balanced
      // `{{ ... }}` substitution or a literal `{{{{` escape. This
      // matches the template syntax documented in scrubber.md.
      const stripped = s
        .replaceAll('{{{{', '')
        .replaceAll('}}}}', '')
        .replaceAll(/\{\{[^{}]+\}\}/g, '');
      return !stripped.includes('{') && !stripped.includes('}');
    },
    {
      message: 'placeholder has unbalanced or malformed `{{ ... }}` substitutions',
    },
  );

const FlagsSchema = z
  .string()
  .max(6)
  .regex(/^[imsu]*$/, {
    message: 'scrubber rule flags may only include i, m, s, u; g and y are reserved by the engine',
  })
  .refine((flags) => new Set(flags).size === flags.length, {
    message: 'scrubber rule flags must not repeat',
  });

const PatternSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (src) => {
      try {
        // Smoke-test compilation against Node's engine. The loader
        // additionally enforces RE2 compatibility; this catches the
        // common "user typed an invalid regex" case at parse time.
        new RegExp(src);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'pattern must be a syntactically valid regular expression' },
  );

export const ScrubberRuleSchema = z
  .object({
    id: ScrubberRuleIdSchema,
    description: z.string().min(1).max(512),
    pattern: PatternSchema,
    flags: FlagsSchema.optional(),
    placeholder: PlaceholderTemplateSchema,
    severity: ScrubberRuleSeveritySchema,
  })
  .strict();

export type ScrubberRule = z.infer<typeof ScrubberRuleSchema>;

/**
 * `ScrubberRuleSet` is the validated shape of `scrubber.rules` in
 * configuration. Rule order is significant — the first match wins —
 * so the schema preserves it.
 *
 * The rule-id uniqueness check lives here rather than on the array
 * element so the error message points at the duplicated id.
 */
export const ScrubberRuleSetSchema = z
  .array(ScrubberRuleSchema)
  .max(1024)
  .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, {
    message: 'scrubber rule ids must be unique within a rule set',
  });

export type ScrubberRuleSet = z.infer<typeof ScrubberRuleSetSchema>;

/**
 * Default scrubber rule set shipped with Memento.
 *
 * These are the patterns the engine starts with on first run
 * and the value that backs the `scrubber.rules` config key's
 * registered default. The set is intentionally biased toward
 * false positives (per `docs/architecture/scrubber.md`): a
 * redacted secret is recoverable — the user can edit the rule
 * and re-write the memory — but a secret persisted to disk is
 * not.
 *
 * The list is parsed by `ScrubberRuleSetSchema` at module load
 * so a typo here fails fast (and at test time) rather than at
 * the first write.
 */
export const DEFAULT_SCRUBBER_RULES: ScrubberRuleSet = ScrubberRuleSetSchema.parse([
  {
    id: 'openai-api-key',
    description: 'OpenAI-style API key (sk-...)',
    pattern: 'sk-[A-Za-z0-9_-]{20,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'slack-token',
    description: 'Slack bot/user/app token (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)',
    pattern: 'xox[abprs]-[A-Za-z0-9-]{10,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'github-token',
    description: 'GitHub personal-access / OAuth / app token',
    pattern: '(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'aws-access-key',
    description: 'AWS access key id (AKIA / ASIA)',
    pattern: '\\b(AKIA|ASIA)[0-9A-Z]{16}\\b',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'jwt',
    description: 'JWT-shaped token (header.payload.signature, base64url)',
    pattern: 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'secret-assignment',
    description: 'Conventional secret-bearing variable assignment (PASSWORD=..., SECRET=..., etc.)',
    pattern: '\\b(PASSWORD|SECRET|API[_-]?KEY|TOKEN)\\s*[:=]\\s*\\S+',
    flags: 'i',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'email',
    description: 'Email address',
    // Domain split into non-overlapping label classes. The earlier
    // form `[A-Za-z0-9.-]+\\.[A-Za-z]{2,}` admits `.` inside the
    // greedy class *and* in the fixed `\\.` boundary; on adversarial
    // input like `a.a.a.a.a@a.a.a.a.a` the engine backtracks
    // quadratically. Splitting into `[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*`
    // keeps `.` out of the greedy class so each label is bounded
    // and the overall scan is linear.
    pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}',
    placeholder: '<email-redacted>',
    severity: 'medium',
  },
]);
