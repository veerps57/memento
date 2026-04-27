import { describe, expect, it } from 'vitest';

import { renderServeReady } from '../src/serve-ready.js';

describe('renderServeReady', () => {
  it('emits a single-line head + tail when colour is off', () => {
    const out = renderServeReady('0.1.0', '/tmp/m.db', { color: false });
    expect(out).toBe(
      'memento 0.1.0 · MCP server ready on stdio · db: /tmp/m.db\npress Ctrl-C to stop\n',
    );
  });

  it('embeds the version verbatim', () => {
    const out = renderServeReady('9.9.9-rc.1', '/x/y.db', { color: false });
    expect(out).toContain('memento 9.9.9-rc.1');
  });

  it('embeds the db path verbatim', () => {
    const out = renderServeReady('0.1.0', '/Users/me/.local/share/memento/memento.db', {
      color: false,
    });
    expect(out).toContain('db: /Users/me/.local/share/memento/memento.db');
  });

  it('wraps the head in cyan ANSI when colour is on', () => {
    const out = renderServeReady('0.1.0', '/tmp/m.db', { color: true });
    expect(out).toContain('\u001b[36m');
    expect(out).toContain('\u001b[0m');
  });

  it('does not emit ANSI when colour is off', () => {
    const out = renderServeReady('0.1.0', '/tmp/m.db', { color: false });
    expect(out).not.toContain('\u001b[');
  });

  it('always ends with a trailing newline', () => {
    expect(renderServeReady('0.1.0', '/x', { color: false }).endsWith('\n')).toBe(true);
    expect(renderServeReady('0.1.0', '/x', { color: true }).endsWith('\n')).toBe(true);
  });
});
