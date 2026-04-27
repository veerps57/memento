// Unit tests for `deriveMcpName` / `defaultMcpName` (ADR-0010).
//
// Pin two properties:
//   1. The `noun.verb` → `verb_noun` default applies when no
//      override is set.
//   2. `metadata.mcpName` overrides the default verbatim.
// And that the default rejects malformed inputs that would
// silently produce a wrong name.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultMcpName, deriveMcpName } from '../../src/commands/mcp-name.js';
import type { AnyCommand } from '../../src/commands/types.js';

function fakeCommand(name: string, mcpName?: string): AnyCommand {
  return {
    name,
    sideEffect: 'read',
    surfaces: ['mcp'],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    metadata: { description: 'x', ...(mcpName !== undefined ? { mcpName } : {}) },
    handler: async () => ({ ok: true, value: {} }),
  };
}

describe('defaultMcpName', () => {
  it.each([
    ['memory.read', 'read_memory'],
    ['memory.write', 'write_memory'],
    ['memory.search', 'search_memory'],
    ['conflict.resolve', 'resolve_conflict'],
    ['config.get', 'get_config'],
    ['compact.run', 'run_compact'],
  ])('transforms %s → %s', (input, expected) => {
    expect(defaultMcpName(input)).toBe(expected);
  });

  it('preserves underscores in the verb half', () => {
    // `memory.set_embedding`'s default would be `set_embedding_memory`.
    // The registry overrides it to `set_memory_embedding`; this test
    // pins the default so the override remains the only difference.
    expect(defaultMcpName('memory.set_embedding')).toBe('set_embedding_memory');
  });

  it.each(['no-dot', '.leading', 'trailing.', 'two.dots.here', ''])(
    'rejects malformed name %s',
    (bad) => {
      expect(() => defaultMcpName(bad)).toThrow();
    },
  );
});

describe('deriveMcpName', () => {
  it('returns metadata.mcpName when set', () => {
    expect(deriveMcpName(fakeCommand('memory.list', 'list_memories'))).toBe('list_memories');
  });

  it('falls back to defaultMcpName when override is omitted', () => {
    expect(deriveMcpName(fakeCommand('memory.read'))).toBe('read_memory');
  });

  it('lets the override be a name the default would not produce', () => {
    expect(deriveMcpName(fakeCommand('memory.events', 'list_memory_events'))).toBe(
      'list_memory_events',
    );
  });
});
