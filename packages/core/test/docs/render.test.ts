// Tests for the reference-doc renderers.
//
// The renderers are pure functions over the source-of-truth
// registries; the tests assert the output is a non-empty
// Markdown string that includes every entry from the input,
// plus the canonical "do not edit by hand" header that the
// `docs:check` gate ultimately enforces.
//
// We intentionally do not snapshot the full document — the test
// would then be a copy of the renderer and any prose tweak
// would require updating two places. Instead we assert
// structural invariants: header present, every input present,
// stable ordering, no obvious markdown corruption.

import { CONFIG_KEYS, ERROR_CODES } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMementoApp } from '../../src/bootstrap.js';
import type { AnyCommand } from '../../src/commands/types.js';
import {
  renderCliDoc,
  renderConfigKeysDoc,
  renderErrorCodesDoc,
  renderMcpToolsDoc,
} from '../../src/docs/index.js';

// `AnyCommand` is `Command<any, any>`; the zod imports are only
// here so we can build typed fixtures for the empty-list case.
void z;

async function liveCommands(): Promise<{
  commands: readonly AnyCommand[];
  close: () => void;
}> {
  const app = await createMementoApp({ dbPath: ':memory:' });
  return {
    commands: app.registry.list() as unknown as readonly AnyCommand[],
    close: () => app.close(),
  };
}

const HEADER_NEEDLE = 'Do not edit by hand.';

describe('renderMcpToolsDoc', () => {
  it('renders a do-not-edit header and every mcp-surface command', async () => {
    const { commands, close } = await liveCommands();
    try {
      const doc = renderMcpToolsDoc(commands);
      expect(doc).toContain(HEADER_NEEDLE);
      const mcpNames = commands.filter((c) => c.surfaces.includes('mcp')).map((c) => c.name);
      expect(mcpNames.length).toBeGreaterThan(0);
      for (const name of mcpNames) {
        expect(doc).toContain(`\`${name}\``);
      }
      expect(doc.endsWith('\n')).toBe(true);
    } finally {
      close();
    }
  });

  it('omits commands without mcp in their surfaces', () => {
    const fake: AnyCommand = {
      name: 'unreachable.cli_only',
      sideEffect: 'admin',
      surfaces: ['cli'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      metadata: { description: 'placeholder' },
      handler: async () => ({ ok: true, value: {} }),
    };
    const doc = renderMcpToolsDoc([fake]);
    expect(doc).not.toContain('unreachable.cli_only');
    expect(doc).toContain('Total: 0 tools.');
  });

  it('sorts commands by name', () => {
    const a: AnyCommand = {
      name: 'memory.zeta',
      sideEffect: 'read',
      surfaces: ['mcp'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      metadata: { description: 'z' },
      handler: async () => ({ ok: true, value: {} }),
    };
    const b: AnyCommand = {
      name: 'memory.alpha',
      sideEffect: 'read',
      surfaces: ['mcp'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      metadata: { description: 'a' },
      handler: async () => ({ ok: true, value: {} }),
    };
    const doc = renderMcpToolsDoc([a, b]);
    expect(doc.indexOf('memory.alpha')).toBeLessThan(doc.indexOf('memory.zeta'));
  });
});

describe('renderCliDoc', () => {
  it('renders every cli-surface command as `memento <subpath>`', async () => {
    const { commands, close } = await liveCommands();
    try {
      const doc = renderCliDoc(commands);
      expect(doc).toContain(HEADER_NEEDLE);
      const cliCommands = commands.filter((c) => c.surfaces.includes('cli'));
      expect(cliCommands.length).toBeGreaterThan(0);
      for (const cmd of cliCommands) {
        const path = `memento ${cmd.name.split('.').join(' ')}`;
        expect(doc).toContain(`\`${path}\``);
      }
    } finally {
      close();
    }
  });

  it('renders the global flags table', () => {
    const doc = renderCliDoc([]);
    expect(doc).toContain('## Global flags');
    expect(doc).toContain('`--db <path>`');
    expect(doc).toContain('`--format json\\|text\\|auto`');
    expect(doc).toContain('`--debug`');
    expect(doc).toContain('`--version, -V`');
    expect(doc).toContain('`--help, -h`');
  });

  it('renders lifecycle commands as `memento <subpath>` with descriptions', () => {
    const doc = renderCliDoc(
      [],
      [
        { name: 'serve', description: 'Run the MCP server over stdio.' },
        { name: 'context', description: 'Print runtime context.' },
        { name: 'store.migrate', description: 'Run pending migrations.' },
      ],
    );
    expect(doc).toContain('## Lifecycle commands');
    expect(doc).toContain('`memento serve`');
    expect(doc).toContain('Run the MCP server over stdio.');
    expect(doc).toContain('`memento context`');
    expect(doc).toContain('Print runtime context.');
    expect(doc).toContain('`memento store migrate`');
    expect(doc).toContain('Run pending migrations.');
    // Lifecycle commands sort alphabetically.
    expect(doc.indexOf('`memento context`')).toBeLessThan(doc.indexOf('`memento serve`'));
    expect(doc.indexOf('`memento serve`')).toBeLessThan(doc.indexOf('`memento store migrate`'));
  });

  it('falls back to "(none registered)" when no lifecycle entries are passed', () => {
    const doc = renderCliDoc([]);
    expect(doc).toContain('## Lifecycle commands');
    expect(doc).toContain('_(none registered)_');
  });
});

describe('renderConfigKeysDoc', () => {
  it('lists every CONFIG_KEYS entry with its default and mutability', () => {
    const doc = renderConfigKeysDoc(CONFIG_KEYS);
    expect(doc).toContain(HEADER_NEEDLE);
    for (const name of Object.keys(CONFIG_KEYS)) {
      expect(doc).toContain(`\`${name}\``);
    }
    // The table separator must appear at least once per namespace
    // group; the registry has multiple namespaces so we just
    // require ≥1.
    expect(doc).toMatch(/\| --- \| --- \| --- \| --- \|/);
    expect(doc.endsWith('\n')).toBe(true);
  });

  it('renders a non-mutable key as no', () => {
    // Find an immutable key in the registry to make this stable.
    const immutable = Object.entries(CONFIG_KEYS).find(([, def]) => !def.mutable);
    if (immutable === undefined) {
      // No immutable keys — the assertion is vacuously true; skip.
      return;
    }
    const [key] = immutable;
    const doc = renderConfigKeysDoc(CONFIG_KEYS);
    const row = doc.split('\n').find((line) => line.startsWith(`| \`${key}\``));
    expect(row).toBeDefined();
    expect(row).toContain('| no |');
  });
});

describe('renderMcpToolsDoc — metadata branches', () => {
  it('renders longDescription, since, deprecated, and mcp hints when present', () => {
    const decorated: AnyCommand = {
      name: 'test.decorated',
      sideEffect: 'read',
      surfaces: ['mcp'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      metadata: {
        description: 'Short description.',
        longDescription: 'Extended explanation paragraph.',
        since: '1.2.0',
        deprecated: 'Use test.better instead.',
        mcp: {
          title: 'Decorated Tool',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      handler: async () => ({ ok: true, value: {} }),
    };
    const doc = renderMcpToolsDoc([decorated]);
    expect(doc).toContain('Extended explanation paragraph.');
    expect(doc).toContain('**Since:** 1.2.0');
    expect(doc).toContain('**Deprecated:** Use test.better instead.');
    expect(doc).toContain('**MCP hints:**');
    expect(doc).toContain('title=`Decorated Tool`');
    expect(doc).toContain('readOnlyHint=`true`');
    expect(doc).toContain('destructiveHint=`false`');
    expect(doc).toContain('idempotentHint=`true`');
  });
});

describe('renderCliDoc — metadata branches', () => {
  it('renders longDescription, since, and deprecated when present on CLI commands', () => {
    const decorated: AnyCommand = {
      name: 'test.fancy',
      sideEffect: 'write',
      surfaces: ['cli'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      metadata: {
        description: 'Basic.',
        longDescription: 'Expanded info for CLI.',
        since: '2.0.0',
        deprecated: 'Superseded by test.fancier.',
      },
      handler: async () => ({ ok: true, value: {} }),
    };
    const doc = renderCliDoc([decorated]);
    expect(doc).toContain('Expanded info for CLI.');
    expect(doc).toContain('**Since:** 2.0.0');
    expect(doc).toContain('**Deprecated:** Superseded by test.fancier.');
  });
});

describe('renderConfigKeysDoc — formatDefault branches', () => {
  it('formats a key whose default is very long with truncation', () => {
    const long: Record<
      string,
      { default: unknown; mutable: boolean; description: string; schema: z.ZodType<unknown> }
    > = {
      'test.longDefault': {
        default: 'a'.repeat(200),
        mutable: true,
        description: 'A key with a very long default.',
        schema: z.string(),
      },
    };
    const doc = renderConfigKeysDoc(long as never);
    // The rendered default should be truncated (the full 200-char
    // string would exceed DEFAULT_PREVIEW_LIMIT).
    expect(doc).toContain('…');
  });

  it('formats a key whose default contains backticks', () => {
    const backtick: Record<
      string,
      { default: unknown; mutable: boolean; description: string; schema: z.ZodType<unknown> }
    > = {
      'test.backtick': {
        default: 'value with `ticks` inside',
        mutable: true,
        description: 'A key whose default has backticks.',
        schema: z.string(),
      },
    };
    const doc = renderConfigKeysDoc(backtick as never);
    // Backtick inside code span → switched to <code> wrapper.
    expect(doc).toContain('<code>');
  });
});

describe('renderErrorCodesDoc', () => {
  it('lists every ERROR_CODES entry exactly once', () => {
    const doc = renderErrorCodesDoc();
    expect(doc).toContain(HEADER_NEEDLE);
    for (const code of ERROR_CODES) {
      // Each code appears as a code-spanned cell. Match that
      // specific shape (not a substring) to avoid false hits
      // from descriptions that happen to mention another code.
      const occurrences = doc.split(`| \`${code}\` |`).length - 1;
      expect(occurrences).toBe(1);
    }
  });
});
