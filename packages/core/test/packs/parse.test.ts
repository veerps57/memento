import { describe, expect, it } from 'vitest';
import { parsePackManifest } from '../../src/packs/parse.js';

const validYaml = `
format: memento-pack/v1
id: rust-axum
version: 1.0.0
title: Rust + Axum web service conventions
description: Conventions for building Axum-based services.
memories:
  - kind: fact
    content: Axum is the canonical Rust web framework here.
  - kind: preference
    content: |
      build-tool: cargo
      Always use cargo for builds.
`;

describe('parsePackManifest', () => {
  it('parses a minimal valid manifest', () => {
    const result = parsePackManifest(validYaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe('rust-axum');
    expect(result.manifest.version).toBe('1.0.0');
    expect(result.manifest.memories).toHaveLength(2);
    expect(result.manifest.memories[0]).toEqual({
      kind: 'fact',
      content: 'Axum is the canonical Rust web framework here.',
    });
    expect(result.warnings).toEqual([]);
  });

  it('preserves multi-line content via YAML literal blocks', () => {
    const result = parsePackManifest(validYaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const second = result.manifest.memories[1];
    expect(second?.kind).toBe('preference');
    expect(second?.content).toBe('build-tool: cargo\nAlways use cargo for builds.\n');
  });

  it('warns and continues for unknown top-level keys (forward-compat)', () => {
    const yaml = `${validYaml.trim()}\nembeddings:\n  enabled: true\n`;
    const result = parsePackManifest(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toContain(
      'unknown top-level key "embeddings" ignored (forward-compat)',
    );
  });

  it('refuses an unsupported format string with a clear message', () => {
    const yaml =
      'format: memento-pack/v9\nid: x\nversion: 1.0.0\ntitle: x\nmemories:\n  - kind: fact\n    content: y';
    const result = parsePackManifest(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('memento-pack/v9');
    expect(result.error).toContain('memento-pack/v1');
  });

  it('reports a YAML syntax error with line/column when available', () => {
    // Tab indentation inside a YAML mapping is a hard parser error.
    const result = parsePackManifest('format: memento-pack/v1\n\tid: rust-axum');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.line).toBeGreaterThan(0);
  });

  it('refuses a manifest that is not a top-level mapping', () => {
    const result = parsePackManifest('- 1\n- 2\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('top level');
  });

  it('surfaces schema-level violations (empty memories, missing required field)', () => {
    const noMemories = 'format: memento-pack/v1\nid: x\nversion: 1.0.0\ntitle: x\nmemories: []';
    const r1 = parsePackManifest(noMemories);
    expect(r1.ok).toBe(false);

    const noTitle =
      'format: memento-pack/v1\nid: x\nversion: 1.0.0\nmemories:\n  - kind: fact\n    content: y';
    const r2 = parsePackManifest(noTitle);
    expect(r2.ok).toBe(false);
  });

  it('rejects reserved `pack:*` tags inside the manifest', () => {
    const yaml = `${validYaml.trim()}\ntags: ['pack:foo:1.0.0']\n`;
    const result = parsePackManifest(yaml);
    expect(result.ok).toBe(false);
  });
});
