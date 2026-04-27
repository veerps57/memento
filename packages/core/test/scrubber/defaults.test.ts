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
    ['secret-assignment', 'export PASSWORD=hunter2'],
    ['email', 'mail me at user@example.com please'],
  ])('matches %s', (id, content) => {
    expect(fired(content)).toContain(id);
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
