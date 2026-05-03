import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRUBBER_RULES } from '../../src/scrubber/defaults.js';
import { applyRules } from '../../src/scrubber/engine.js';

function fired(content: string): string[] {
  const { report } = applyRules(content, DEFAULT_SCRUBBER_RULES);
  return report.rules.map((r) => r.ruleId);
}

describe('DEFAULT_SCRUBBER_RULES', () => {
  it('parses cleanly through the schema (no malformed defaults)', () => {
    expect(DEFAULT_SCRUBBER_RULES.length).toBeGreaterThan(0);
    expect(new Set(DEFAULT_SCRUBBER_RULES.map((r) => r.id)).size).toBe(
      DEFAULT_SCRUBBER_RULES.length,
    );
  });

  it.each([
    ['openai-api-key', 'leaked sk-AbCdEfGhIjKlMnOpQrStUv in chat'],
    ['slack-token', 'xoxb-1234567890-abcdefghij in webhook'],
    ['github-token', 'token=ghp_abcdefghijklmnopqrstUVWXYZ0123456789'],
    ['aws-access-key', 'aws id AKIAABCDEFGHIJKLMNOP today'],
    ['jwt', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF6yHV rest'],
    [
      'jwt',
      // The tightened segment minimums admit a JWT with a tiny payload
      // (e.g. unsigned `{}` → base64url `e30`).
      'auth eyJhbGciOiJIUzI1NiJ9.e30.AbCdEfGh rest',
    ],
    ['secret-assignment', 'export PASSWORD=hunter2'],
    ['email', 'mail me at user@example.com please'],
    [
      'private-key-block',
      [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n'),
    ],
    [
      'private-key-block',
      // Both `OPENSSH` and unprefixed `PRIVATE KEY` markers — the
      // `[A-Z ]+` class admits common variants.
      [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
    ],
    ['bearer-token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('matches %s', (id, content) => {
    expect(fired(content)).toContain(id);
  });

  it('does not match the literal word "bearer" mid-prose', () => {
    expect(fired('A bear and a bearer of bad news met up')).not.toContain('bearer-token');
  });

  it('redacts the entire PEM private-key block including delimiters', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { scrubbed } = applyRules(`prefix\n${block}\nsuffix`, DEFAULT_SCRUBBER_RULES);
    expect(scrubbed).not.toContain('BEGIN RSA');
    expect(scrubbed).not.toContain('END RSA');
    expect(scrubbed).toContain('<redacted:private-key-block>');
    expect(scrubbed).toContain('prefix');
    expect(scrubbed).toContain('suffix');
  });

  it('does not redact non-secret prose', () => {
    expect(fired('Met for coffee at 10am to discuss the roadmap.')).toEqual([]);
  });

  it('rewrites the content for high-severity matches', () => {
    const { scrubbed } = applyRules(
      'token=ghp_abcdefghijklmnopqrstUVWXYZ0123456789 done',
      DEFAULT_SCRUBBER_RULES,
    );
    expect(scrubbed).not.toContain('ghp_abcdefghijklmnopqrstUVWXYZ0123456789');
    expect(scrubbed).toContain('<redacted:');
  });
});
