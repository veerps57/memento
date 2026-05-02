// Init walkthrough text-render tests.
//
// The renderer is a UX surface, so we pin:
//   - both colour modes (no ANSI when off; ANSI present when on),
//   - that every supported client appears (display name + path),
//   - that the dbPath is shown for the operator to read,
//   - the special `:memory:` warning surface,
//   - that the `memento doctor` follow-up is suggested.

import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderClientSnippets } from '../src/init-clients.js';
import { renderInitText } from '../src/init-render.js';
import type { InitSnapshot } from '../src/lifecycle/init.js';

// Use the host's real home so renderInitText's `~` collapse fires
// — otherwise a hardcoded `/Users/me` would never match
// `os.homedir()` and the rendered command would print the
// absolute path verbatim.
const SUGGESTED_TARGET = path.join(os.homedir(), '.claude', 'skills');

const SNAPSHOT = (overrides: Partial<InitSnapshot> = {}): InitSnapshot => ({
  version: '0.1.0',
  dbPath: '/Users/me/.local/share/memento/memento.db',
  dbFromEnv: true,
  dbFromDefault: false,
  checks: [],
  clients: renderClientSnippets('/Users/me/.local/share/memento/memento.db'),
  skill: {
    capableClients: ['claude-code', 'claude-desktop'],
    source: '/abs/path/to/skills/memento',
    suggestedTarget: SUGGESTED_TARGET,
  },
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

  describe('skill section', () => {
    it('appears when the rendered set has at least one capable client', () => {
      const out = renderInitText(SNAPSHOT(), { color: false });
      expect(out).toContain('Memento skill');
      // The bundled-source branch prints the cp command targeting
      // the suggested install dir. The source path is passed as-is
      // (forward slashes in our test fixture); the target uses the
      // host's `path.sep`, which is `\` on Windows. Match both.
      expect(out).toContain('cp -R "/abs/path/to/skills/memento"');
      expect(out).toMatch(/~[\\/]\.claude[\\/]skills/);
    });

    it('is suppressed when no rendered client supports skills', () => {
      const out = renderInitText(
        SNAPSHOT({
          skill: {
            capableClients: [],
            source: '/abs/path/to/skills/memento',
            suggestedTarget: SUGGESTED_TARGET,
          },
        }),
        { color: false },
      );
      expect(out).not.toContain('Memento skill');
    });

    it('falls back to a docs pointer when source is not bundled', () => {
      const out = renderInitText(
        SNAPSHOT({
          skill: {
            capableClients: ['claude-code'],
            source: null,
            suggestedTarget: SUGGESTED_TARGET,
          },
        }),
        { color: false },
      );
      expect(out).toContain('Memento skill');
      // The not-staged branch points at the workspace-relative
      // path so a contributor on a clone has something to copy.
      expect(out).toContain('skills/memento');
      expect(out).toContain('not staged');
    });

    it('mentions the third-party fallback for non-Anthropic clients', () => {
      const out = renderInitText(SNAPSHOT(), { color: false });
      expect(out).toContain('teach-your-assistant.md');
    });

    it('renders the absolute path when suggestedTarget lives outside $HOME', () => {
      // displayHomePath's "outside home" branch — the renderer
      // should not invent a `~` for paths that are not under the
      // user's home directory.
      const out = renderInitText(
        SNAPSHOT({
          skill: {
            capableClients: ['claude-code'],
            source: '/abs/path/to/skills/memento',
            suggestedTarget: '/var/system/.claude/skills',
          },
        }),
        { color: false },
      );
      expect(out).toContain('/var/system/.claude/skills');
      // Sanity: the install command refers to the absolute target.
      expect(out).toMatch(/cp -R "[^"]+" \/var\/system\/\.claude\/skills/);
    });

    it('renders ~ when suggestedTarget equals $HOME exactly', () => {
      // displayHomePath's "equals home" branch — no
      // path-separator suffix to strip.
      const out = renderInitText(
        SNAPSHOT({
          skill: {
            capableClients: ['claude-code'],
            source: '/abs/path/to/skills/memento',
            suggestedTarget: os.homedir(),
          },
        }),
        { color: false },
      );
      // The cp command's target uses the bare `~`.
      expect(out).toMatch(/cp -R "[^"]+" ~\//);
    });
  });
});
