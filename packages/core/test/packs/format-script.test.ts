// Unit tests for `scripts/format-packs.mjs`'s `format()` function.
//
// `pnpm format:packs:check` (run in CI via `pnpm verify`) catches
// drift on the bundled packs themselves; these tests pin the
// canonicalisation rules so a refactor of the script can't
// silently change what "canonical" means without one of these
// asserts firing.

import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs script imports lack a typed surface but
// the shape is stable and pinned by these tests.
import { format } from '../../../../scripts/format-packs.mjs';

describe('format-packs.mjs format()', () => {
  it('reorders top-level keys into canonical order', () => {
    const input = `memories:
  - kind: fact
    content: x
title: T
version: 0.1.0
id: my-pack
format: memento-pack/v1
`;
    const out = format(input);
    // Expected order: format, id, version, title, …, memories
    const indices = {
      format: out.indexOf('format:'),
      id: out.indexOf('id:'),
      version: out.indexOf('version:'),
      title: out.indexOf('title:'),
      memories: out.indexOf('memories:'),
    };
    expect(indices.format).toBeLessThan(indices.id);
    expect(indices.id).toBeLessThan(indices.version);
    expect(indices.version).toBeLessThan(indices.title);
    expect(indices.title).toBeLessThan(indices.memories);
  });

  it('reorders per-memory keys into canonical order', () => {
    const input = `format: memento-pack/v1
id: my-pack
version: 0.1.0
title: T
memories:
  - tags: [a]
    content: x
    pinned: true
    kind: fact
`;
    const out = format(input);
    // Expected per-item order: kind, content, …, tags, pinned, …
    // We assert the relative order of `kind`, `content`, `tags`,
    // `pinned` lines within the first memory entry.
    const memoriesStart = out.indexOf('memories:');
    const slice = out.slice(memoriesStart);
    const kind = slice.indexOf('kind:');
    const content = slice.indexOf('content:');
    const tags = slice.indexOf('tags:');
    const pinned = slice.indexOf('pinned:');
    expect(kind).toBeLessThan(content);
    expect(content).toBeLessThan(tags);
    expect(tags).toBeLessThan(pinned);
  });

  it('preserves a leading yaml-language-server comment header', () => {
    const input = `# yaml-language-server: $schema=https://example.com/schema.json

format: memento-pack/v1
id: my-pack
version: 0.1.0
title: T
memories:
  - kind: fact
    content: x
`;
    const out = format(input);
    expect(out.startsWith('# yaml-language-server: $schema=https://example.com/schema.json')).toBe(
      true,
    );
    // Header is followed by exactly one blank line before the body.
    const lines = out.split('\n');
    expect(lines[0]).toBe('# yaml-language-server: $schema=https://example.com/schema.json');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('format: memento-pack/v1');
  });

  it('adds a blank line between top-level memory entries', () => {
    const input = `format: memento-pack/v1
id: my-pack
version: 0.1.0
title: T
memories:
  - kind: fact
    content: a
  - kind: fact
    content: b
  - kind: fact
    content: c
`;
    const out = format(input);
    // Three `  - kind: fact` openers; two blank lines between them.
    const blankLineMatches = out.match(/\n\n {2}- /g) ?? [];
    expect(blankLineMatches.length).toBe(2);
  });

  it('is idempotent — formatting canonical output yields the same string', () => {
    const input = `# yaml-language-server: $schema=https://x/y.json

format: memento-pack/v1
id: my-pack
version: 0.1.0
title: T
memories:
  - kind: fact
    content: a
  - kind: preference
    content: b
`;
    const first = format(input);
    const second = format(first);
    expect(second).toBe(first);
  });

  it('ends with exactly one final newline', () => {
    const input = `format: memento-pack/v1
id: my-pack
version: 0.1.0
title: T
memories:
  - kind: fact
    content: x`;
    const out = format(input);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('emits multi-line content as block-literal scalars', () => {
    const input = `format: memento-pack/v1
id: my-pack
version: 0.1.0
title: T
memories:
  - kind: fact
    content: "line one\\nline two\\nline three"
`;
    const out = format(input);
    // The yaml lib emits literal-block (`|`) when multi-line content
    // is present and our STRINGIFY_OPTS sets blockQuote: 'literal'.
    expect(out).toMatch(/content: \|/);
  });

  it('throws on input that is not a YAML mapping at the top level', () => {
    expect(() => format('- 1\n- 2\n')).toThrow(/mapping/);
  });
});
