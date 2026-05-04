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
    // Synthetic vendor-key shapes — assembled at runtime so source-level
    // secret scanners (GitHub push-protection, etc.) don't flag the literal.
    // None of these are real secrets; they exercise the regex shape only.
    ['stripe-key', `pay ${'sk_'}live_51H${'x'.repeat(24)}LkvLbW today`],
    ['stripe-key', `test ${'pk_'}test_51H${'x'.repeat(24)}RtVsZ0 ok`],
    ['google-api-key', `maps ${'AI'}za${'SyD'}${'x'.repeat(32)} end`],
    [
      'sendgrid-key',
      // SendGrid format: SG.<22-char-id>.<43-char-secret>
      `api SG.${'a'.repeat(22)}.${'b'.repeat(43)} end`,
    ],
    [
      'discord-token',
      // Discord format: M{23–25}.{6}.{27+}
      `bot ${'M'}${'A'.repeat(25)}.${'b'.repeat(6)}.${'C'.repeat(38)} end`,
    ],
    ['jwt', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF6yHV rest'],
    [
      'jwt',
      // The tightened segment minimums admit a JWT with a tiny payload
      // (e.g. unsigned `{}` → base64url `e30`).
      'auth eyJhbGciOiJIUzI1NiJ9.e30.AbCdEfGh rest',
    ],
    ['secret-assignment', 'export PASSWORD=hunter2'],
    // underscore-bound compound names now caught
    ['secret-assignment', 'config secret_token: foobar end'],
    ['secret-assignment', 'env SECRET_TOKEN=barfoo done'],
    ['secret-assignment', 'cfg access_token: snake.case.value end'],
    ['secret-assignment', 'aws_session_token: FQoGZXIvYXdzEPL end'],
    // bonus: camelCase variants caught (case-insensitive flag + suffix-prefix idiom)
    ['secret-assignment', 'config apiToken="camelCase456" end'],
    ['secret-assignment', 'authToken: bearerthing end'],
    // Authorization Basic / Digest
    ['basic-auth', 'header Authorization: Basic dXNlcjpzZWNyZXRwYXNzd29yZA=='],
    ['basic-auth', 'header Authorization: Digest username="admin", realm="x", nonce="abc1234567"'],
    // DB connection-string credentials with FQDN host
    ['db-credential', 'DB postgres://admin:hunter2secret@db.example.com:5432/main end'],
    // Hostnames use RFC 2606 example domains so vendor-cloud secret
    // scanners (MongoDB Atlas, Upstash, etc.) don't pattern-match the
    // synthetic credential URI as a real one. The scrubber rule is
    // host-agnostic — only the scheme + user:pass@ shape matters.
    ['db-credential', 'cache redis://default:redisPassword@cache.example.com:6379'],
    ['db-credential', 'queue amqp://guest:guestpw@rabbit.example.com/vhost'],
    // Boundary: non-FQDN host (a previously-leaked case) now caught
    ['db-credential', 'DB mysql://root:rootpw_secret@mysql-host/sales end'],
    ['db-credential', 'DB mongodb://dbuser:mongoSecret@cluster0.example.net/store end'],
    // PII (CC + SSN)
    ['credit-card', 'card 4111-1111-1111-1111 today'],
    ['credit-card', 'card 4111111111111111 today'],
    ['credit-card', 'amex 3782-822463-10005 today'],
    ['ssn', 'ssn 123-45-6789 today'],
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

  // db-credential must run before email so connection strings are
  // not mislabeled as <email-redacted>.
  it('redacts a postgres connection string with the db-credential rule, preserving the host', () => {
    const { scrubbed, report } = applyRules(
      'DB: postgres://admin:hunter2secret@db.example.com:5432/main',
      DEFAULT_SCRUBBER_RULES,
    );
    expect(scrubbed).not.toContain('hunter2secret');
    expect(scrubbed).toContain('db.example.com');
    expect(scrubbed).toContain('<redacted:db-credential>@');
    expect(scrubbed).not.toContain('<email-redacted>');
    expect(report.rules.map((r) => r.ruleId)).toContain('db-credential');
  });

  // Mysql-style internal hosts (no FQDN suffix) — the email rule
  // never matched these, so the password used to leak entirely.
  it('redacts mysql connection strings even when the host has no FQDN', () => {
    const { scrubbed } = applyRules(
      'DB: mysql://root:rootpw_secret@mysql-host/sales',
      DEFAULT_SCRUBBER_RULES,
    );
    expect(scrubbed).not.toContain('rootpw_secret');
    expect(scrubbed).toContain('mysql-host');
    expect(scrubbed).toContain('<redacted:db-credential>@');
  });

  // URL query-string redaction stops at `&` so trailing params survive.
  it('redacts ?secret=... without eating trailing &param= pairs', () => {
    const { scrubbed } = applyRules(
      'https://app.example.com/reset?secret=abc123longSecretValue&user=42&campaign=launch',
      DEFAULT_SCRUBBER_RULES,
    );
    expect(scrubbed).not.toContain('abc123longSecretValue');
    expect(scrubbed).toContain('user=42');
    expect(scrubbed).toContain('campaign=launch');
  });

  // compound underscore-bound keywords are redacted.
  it('redacts secret_token, access_token, aws_session_token, authToken, apiToken assignments', () => {
    const { scrubbed } = applyRules(
      [
        'secret_token: foobar_value',
        'SECRET_TOKEN=barfoo',
        'access_token: snake.case.token',
        'auth_token: bearerthing',
        'aws_session_token: FQoGZXIvYXdzEPL',
        'apiToken="camelCase456"',
      ].join(' || '),
      DEFAULT_SCRUBBER_RULES,
    );
    expect(scrubbed).not.toContain('foobar_value');
    expect(scrubbed).not.toContain('barfoo');
    expect(scrubbed).not.toContain('snake.case.token');
    expect(scrubbed).not.toContain('bearerthing');
    expect(scrubbed).not.toContain('FQoGZXIvYXdzEPL');
    expect(scrubbed).not.toContain('camelCase456');
  });

  // negative: identifiers that EMBED a keyword without an assignment
  // operator must NOT match — the keyword has to be immediately followed
  // by `\s*[:=]`.
  it('does not redact keyword-embedded identifiers without an assignment operator', () => {
    const { scrubbed } = applyRules(
      'mytokenfile points to ~/data and password_helper.exe is on path',
      DEFAULT_SCRUBBER_RULES,
    );
    expect(scrubbed).toContain('mytokenfile');
    expect(scrubbed).toContain('password_helper.exe');
  });

  it('does not redact mid-prose mentions of secret-keyword nouns', () => {
    expect(fired('She told me her favourite token of affection was a small fern.')).not.toContain(
      'secret-assignment',
    );
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
