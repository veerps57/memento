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
    id: 'stripe-key',
    description: 'Stripe live/test API key (sk_live_, pk_live_, rk_live_, sk_test_, ...)',
    pattern: '\\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{24,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'google-api-key',
    description: 'Google API key (AIzaSy...)',
    pattern: '\\bAIza[A-Za-z0-9_-]{35}\\b',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'sendgrid-key',
    description: 'SendGrid API key (SG.*.*)',
    pattern: '\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}\\b',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'discord-token',
    description: 'Discord bot/user token (3 base64-shaped segments separated by dots)',
    pattern: '\\b[MN][A-Za-z\\d]{23,25}\\.[\\w-]{6}\\.[\\w-]{27,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'jwt',
    description: 'JWT-shaped token (header.payload.signature, base64url)',
    // Real-world JWT shapes: the header is base64url of an
    // algorithm object — `{"alg":"HS256","typ":"JWT"}` is ~37
    // chars, `{"alg":"none"}` is ~20 — so `{8,}` after `eyJ` is
    // a safe floor. The payload can legitimately encode the
    // empty object `{}` (3 chars: `e30`); the previous `{8,}`
    // missed those. The signature ranges from 0 chars
    // (unsigned) to 43+ (HS256/RS256); `{4,}` covers every
    // signed JWT while keeping false positives low. The `eyJ`
    // anchor is what carries the "JWT-shaped" signal, not the
    // segment lengths.
    pattern: 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{2,}\\.[A-Za-z0-9_-]{4,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'private-key-block',
    description: 'PEM-encoded private key block (RSA/EC/PGP/etc.)',
    // Match a single `-----BEGIN ... PRIVATE KEY-----` block to
    // its corresponding END marker. Non-greedy `[\s\S]+?` is
    // the right shape: every iteration the engine extends by
    // one char and tries the END suffix; if absent, it advances
    // one. Linear in input size — ReDoS-safe. SECURITY.md
    // advertises this rule as part of the default scrubber
    // coverage; before this entry the claim was a documentation
    // bug.
    pattern: '-----BEGIN [A-Z ]+PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]+PRIVATE KEY-----',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'bearer-token',
    description: 'HTTP Authorization: Bearer header',
    // `\bBearer` anchors the literal so prose containing "bear"
    // / "bearer" mid-word does not match. The class
    // `[A-Za-z0-9._~+/=-]` covers JWT-style tokens, opaque
    // base64 tokens, and URL-safe variants; `{16,}` keeps
    // out the trivial "Bearer foo" false positive. Single
    // bounded class + single quantifier — linear, ReDoS-safe.
    pattern: '\\bBearer\\s+[A-Za-z0-9._~+/=-]{16,}',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'basic-auth',
    description: 'HTTP Authorization: Basic / Digest header',
    // Mirrors `bearer-token` but matches the Basic and Digest
    // schemes. The character class is wide enough to cover
    // base64 (Basic) and the comma-separated key="value" syntax
    // of Digest, while the `{8,}` floor avoids matching short
    // human-readable strings.
    pattern: '\\bAuthorization:\\s*(Basic|Digest)\\s+[A-Za-z0-9+/=._~"-]{8,}',
    flags: 'i',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'db-credential',
    description:
      'Inline credentials in a DB-style URL (postgres://, mysql://, mongodb://, redis://, amqp://)',
    // Match `<scheme>://<user>:<password>@`, including the trailing
    // `@`. The placeholder ends with a literal `@` so the host
    // portion of the URL survives the redaction. Bounded character
    // classes (no `.+`) keep the pattern linear-time.
    //
    // ORDER MATTERS: this rule MUST run before `email`. The email
    // pattern would otherwise match `password@host` style suffixes
    // and rewrite them to `<email-redacted>`, which is mislabeled
    // and eats the host. The "first match wins" rule in the engine
    // ensures `db-credential` claims the span first.
    pattern:
      '\\b(?:postgres|postgresql|mysql|mariadb|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps)://[^/\\s:@]+:[^@\\s]+@',
    placeholder: '<redacted:{{rule.id}}>@',
    severity: 'high',
  },
  {
    id: 'secret-assignment',
    description:
      'Conventional secret-bearing variable assignment (PASSWORD=..., secret_token=..., aws_session_token=..., apiToken=..., etc.)',
    // Pattern walk-through:
    //
    //   - `[A-Za-z0-9_]*` — optional identifier prefix. Lets the
    //     keyword sit at the END of a compound name like
    //     `secret_token`, `aws_session_token`, `apiToken`. Greedy
    //     so the engine first tries the longest prefix, but it
    //     backtracks until the keyword + assignment-operator
    //     constraint is satisfied.
    //   - `(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|KEY)`
    //     — the keyword set. Case-insensitive flag means `Token`,
    //     `password`, `Secret`, etc. all match. Combined with the
    //     identifier prefix above, compound names like
    //     `secret_token` and camelCase forms like `apiToken` both
    //     resolve to a keyword match at the suffix.
    //   - `\s*[:=]\s*` — the assignment operator. Forces the
    //     keyword to be IMMEDIATELY followed by `=` or `:` (after
    //     optional whitespace), which is what prevents bogus
    //     matches inside identifiers like `mytokenfile=foo`.
    //   - Value alternatives, tried left-to-right:
    //       1. `"[^"\n]+"` — double-quoted single-line string
    //          (handles values that begin with `"`).
    //       2. `'[^'\n]+'` — single-quoted single-line string.
    //       3. `[^\s,;&'"\]\)\}]+` — bare value, stopping at
    //          whitespace, commas, semicolons, ampersands, quotes,
    //          or brackets. The `&` terminator is what keeps URL
    //          redaction (`?secret=foo&user=42`) from eating the
    //          trailing `&user=42`.
    pattern:
      '[A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|KEY)\\s*[:=]\\s*(?:"[^"\\n]+"|\'[^\'\\n]+\'|[^\\s,;&\'"\\]\\)\\}]+)',
    flags: 'i',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'credit-card',
    description:
      'Credit card number (Visa / Mastercard / Discover 4-4-4-4 or AmEx 4-6-5, optional dashes/spaces)',
    // Two alternatives. Format-only check — no Luhn validation in
    // the regex. The engine is intentionally biased toward false
    // positives; a redacted CC is recoverable, a leaked one isn't.
    //
    //   - 4-4-4-4 (16 digits): Visa starts with 4, Mastercard with
    //     51-55, Discover with 6011 or 65xx.
    //   - 4-6-5 (15 digits): AmEx starts with 34 or 37.
    pattern:
      '\\b(?:(?:4\\d{3}|5[1-5]\\d{2}|6(?:011|5\\d{2}))[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}|3[47]\\d{2}[\\s-]?\\d{6}[\\s-]?\\d{5})\\b',
    placeholder: '<redacted:{{rule.id}}>',
    severity: 'high',
  },
  {
    id: 'ssn',
    description: 'US Social Security number (NNN-NN-NNNN)',
    pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
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
