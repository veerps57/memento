// Init walkthrough text-render tests.
//
// The renderer is a UX surface, so we pin:
//   - both colour modes (no ANSI when off; ANSI present when on),
//   - that every supported client appears (display name + path),
//   - that the dbPath is shown for the operator to read,
//   - the special `:memory:` warning surface,
//   - that the `memento doctor` follow-up is suggested.

import { describe, expect, it } from 'vitest';

import { renderClientSnippets } from '../src/init-clients.js';
import { renderInitText } from '../src/init-render.js';
import type { InitSnapshot } from '../src/lifecycle/init.js';

const SNAPSHOT = (overrides: Partial<InitSnapshot> = {}): InitSnapshot => ({
  version: '0.1.0',
  dbPath: '/Users/me/.local/share/memento/memento.db',
  dbFromEnv: true,
  dbFromDefault: false,
  checks: [],
  clients: renderClientSnippets('/Users/me/.local/share/memento/memento.db'),
  ...overrides,
});

describe('renderInitText', () => {
  it('emits no ANSI escapes when colour is off', () => {
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).not.toContain('\u001b[');
  });

  it('emits ANSI escapes when colour is on', () => {
    const out = renderInitText(SNAPSHOT(), { color: true });
    expect(out).toContain('\u001b[');
  });

  it('mentions every supported client by display name', () => {
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('Claude Code');
    expect(out).toContain('Claude Desktop');
    expect(out).toContain('Cursor');
    expect(out).toContain('VS Code');
    expect(out).toContain('OpenCode');
  });

  it('shows each client config path', () => {
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('~/.claude.json');
    expect(out).toContain('claude_desktop_config.json');
    expect(out).toContain('~/.cursor/mcp.json');
    expect(out).toContain('.vscode/mcp.json');
    expect(out).toContain('~/.config/opencode/opencode.json');
  });

  it('shows the resolved dbPath', () => {
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('/Users/me/.local/share/memento/memento.db');
  });

  it('warns when dbPath is :memory:', () => {
    const out = renderInitText(
      SNAPSHOT({ dbPath: ':memory:', clients: renderClientSnippets(':memory:') }),
      { color: false },
    );
    expect(out).toContain(':memory:');
    expect(out.toLowerCase()).toContain('empty store');
  });

  it('warns when dbPath came from --db (not env, not default)', () => {
    const out = renderInitText(SNAPSHOT({ dbFromEnv: false, dbFromDefault: false }), {
      color: false,
    });
    expect(out).toContain('--db');
    expect(out).toContain('MEMENTO_DB');
  });

  it('does not warn when dbPath is the XDG default', () => {
    const out = renderInitText(SNAPSHOT({ dbFromEnv: false, dbFromDefault: true }), {
      color: false,
    });
    expect(out).toContain('default location');
    expect(out).not.toContain('came from --db');
  });

  it('shows install hint for clients that have one', () => {
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('claude mcp add');
  });

  it('suggests memento doctor for verification', () => {
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('memento doctor');
  });

  it('shows the version', () => {
    const out = renderInitText(SNAPSHOT({ version: '9.9.9-rc.1' }), { color: false });
    expect(out).toContain('9.9.9-rc.1');
  });
});
