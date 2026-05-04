// Snippet registry tests.
//
// Pin the public contract: every client's snippet parses as
// JSON, embeds the dbPath verbatim, and (for the
// command/args-shaped clients) advertises the canonical
// `npx -y @psraghuveer/memento serve` invocation. The exact
// JSON shape per client is asserted so a refactor that
// silently drops `env` / `command` / `enabled` is caught.

import { describe, expect, it } from 'vitest';

import { INIT_CLIENT_IDS, renderClientSnippets } from '../src/init-clients.js';

const DB = '/tmp/memento-test.db';

describe('renderClientSnippets', () => {
  it('returns a snippet for every id in INIT_CLIENT_IDS', () => {
    const snippets = renderClientSnippets(DB);
    expect(snippets.map((s) => s.id)).toEqual(INIT_CLIENT_IDS);
  });

  it('embeds the dbPath verbatim in every snippet', () => {
    for (const s of renderClientSnippets(DB)) {
      expect(s.snippet).toContain(DB);
    }
  });

  it('produces valid JSON for every snippet', () => {
    for (const s of renderClientSnippets(DB)) {
      expect(() => JSON.parse(s.snippet)).not.toThrow();
    }
  });

  it('renders Claude Code with the mcpServers envelope', () => {
    const claude = byId('claude-code', DB);
    const parsed = JSON.parse(claude.snippet) as {
      mcpServers: {
        memento: { command: string; args: readonly string[]; env: Record<string, string> };
      };
    };
    expect(parsed.mcpServers).toHaveProperty('memento');
    const m = parsed.mcpServers.memento;
    expect(m.command).toBe('npx');
    expect(m.args).toEqual(['-y', '@psraghuveer/memento', 'serve']);
    expect(m.env).toEqual({ MEMENTO_DB: DB });
    expect(claude.configPath).toContain('.claude');
  });

  it('renders Cursor with the mcpServers envelope', () => {
    const cursor = byId('cursor', DB);
    const parsed = JSON.parse(cursor.snippet) as {
      mcpServers: { memento: unknown };
    };
    expect(parsed.mcpServers).toHaveProperty('memento');
    expect(cursor.configPath).toContain('.cursor');
  });

  it('renders VS Code with the servers envelope and stdio type', () => {
    const vscode = byId('vscode', DB);
    const parsed = JSON.parse(vscode.snippet) as {
      servers: { memento: { type: string } };
    };
    expect(parsed.servers).toHaveProperty('memento');
    expect(parsed.servers.memento.type).toBe('stdio');
    expect(vscode.configPath).toContain('.vscode/mcp.json');
  });

  it('marks every registered client as skill-capable today', () => {
    // Pinning the exact mapping is intentional. The init renderer
    // gates the optional "install the skill" section on this
    // boolean; an accidental flip on a non-supporting client
    // would mislead users into installing into a directory their
    // client does not read.
    //
    // Every client in the registry today loads Anthropic-format
    // skills from `~/.claude/skills/<name>/SKILL.md` (some also
    // accept a client-specific path). When a client we add lacks
    // skill support, flip its entry to `false` here; do not
    // maintain external enumerations.
    const byClient = Object.fromEntries(
      renderClientSnippets(DB).map((s) => [s.id, s.supportsSkills]),
    );
    expect(byClient).toEqual({
      'claude-code': true,
      'claude-desktop': true,
      cursor: true,
      vscode: true,
      opencode: true,
    });
  });

  it('renders OpenCode with the mcp/local envelope and environment field', () => {
    const oc = byId('opencode', DB);
    const parsed = JSON.parse(oc.snippet) as {
      $schema: string;
      mcp: {
        memento: {
          type: string;
          command: readonly string[];
          enabled: boolean;
          environment: Record<string, string>;
        };
      };
    };
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    const m = parsed.mcp.memento;
    expect(m.type).toBe('local');
    expect(m.command).toEqual(['npx', '-y', '@psraghuveer/memento', 'serve']);
    expect(m.enabled).toBe(true);
    expect(m.environment).toEqual({ MEMENTO_DB: DB });
    expect(oc.configPath).toContain('opencode');
  });
});

function byId(id: string, dbPath: string) {
  const found = renderClientSnippets(dbPath).find((s) => s.id === id);
  if (!found) throw new Error(`expected snippet for ${id}`);
  return found;
}
