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

  it('surfaces post-init next steps (status + dashboard)', () => {
    // Persona-2 audit added a `Next:` block so a user who just
    // pasted the snippet learns about `memento status` (their
    // store at a glance) and `memento dashboard` (browser UI)
    // without re-reading the README. Pinned here so the next
    // refactor can't silently drop them.
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('memento status');
    expect(out).toContain('memento dashboard');
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

  it('suggests memento doctor --mcp for verification', () => {
    // Doctor's `--mcp` mode is the variant that actually proves
    // the client-config paste worked (it scans known files and
    // flags shape mismatches), so it's what we recommend in the
    // walkthrough's footer.
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('memento doctor --mcp');
  });

  it('frames the walkthrough as three numbered steps', () => {
    // The renderer mirrors the README / landing / mcp-client-setup
    // three-step quickstart so users see the same mental model
    // across surfaces. Pinned here so the next refactor can't
    // silently drop the framing.
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out).toContain('Step 1');
    expect(out).toContain('Step 2');
    expect(out).toContain('Step 3');
  });

  it('tells the user to restart the client after pasting', () => {
    // Without this nudge first-time users paste, ask a question,
    // get nothing, and give up — the MCP server only loads on
    // client restart.
    const out = renderInitText(SNAPSHOT(), { color: false });
    expect(out.toLowerCase()).toContain('restart your ai client');
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

    it('falls back to the persona-only variant of step 3 when no client supports skills', () => {
      // Step 3 ("teach your assistant") is *always* present so the
      // user knows the wiring on its own isn't enough. When no
      // rendered client supports skills, the section omits the
      // "Memento skill" install block and points exclusively at
      // the persona snippet instead.
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
      expect(out).toContain('Step 3');
      expect(out).toContain('teach-your-assistant.md');
      // No skill install command in this branch.
      expect(out).not.toContain('cp -R');
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

    it('mentions the generic persona fallback for clients without skill support', () => {
      // The renderer must point users at the persona snippet for
      // clients that don't load skills, but the copy is generic
      // on purpose — we don't enumerate which clients fall in
      // that bucket because the list drifts and is the user's
      // concern, not ours.
      const out = renderInitText(SNAPSHOT(), { color: false });
      expect(out).toContain('teach-your-assistant.md');
      expect(out.toLowerCase()).toContain('persona snippet');
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
