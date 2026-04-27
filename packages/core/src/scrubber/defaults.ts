// Default scrubber rule set.
//
// These are the rules that ship with `@psraghuveer/memento-core` and that the
// future config layer prepends to user-supplied rules. The set is
// intentionally biased toward false positives (per
// `docs/architecture/scrubber.md`): a redacted secret is recoverable
// — the user can edit the rule and re-write the memory — but a
// secret persisted to disk is not.
//
// Each entry is parsed by `ScrubberRuleSetSchema` at module load
// time so a typo in this file fails fast (and at test time) rather
// than at the first write.

import { type ScrubberRuleSet, ScrubberRuleSetSchema } from '@psraghuveer/memento-schema';

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
    pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    placeholder: '<email-redacted>',
    severity: 'medium',
  },
]);
