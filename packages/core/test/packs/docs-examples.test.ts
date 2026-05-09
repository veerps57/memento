// Pin every YAML pack example in the user guide against the
// real `parsePackManifest`. If a guide drifts away from the
// shipping schema (a renamed field, a removed optional, an
// outdated kind), this test fails — the docs must update with
// the engine.
//
// Examples are marked in the guide with a literal HTML comment
// `<!-- pack-example -->` immediately preceding the YAML code
// fence. Other YAML blocks in the guide (config snippets, CLI
// outputs) are untouched by this test; only opt-in examples are
// pinned to the schema.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePackManifest } from '../../src/packs/parse.js';

const GUIDE_PATH = join(__dirname, '..', '..', '..', '..', 'docs', 'guides', 'packs.md');

interface Example {
  readonly yaml: string;
  /** 1-based line number of the opening fence; useful when an example fails. */
  readonly lineNumber: number;
}

function extractTaggedYamlExamples(markdown: string): readonly Example[] {
  const lines = markdown.split('\n');
  const examples: Example[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.trim() !== '<!-- pack-example -->') continue;
    // Walk forward to the opening ```yaml fence.
    let j = i + 1;
    while (j < lines.length && lines[j]?.trim() === '') j += 1;
    const fenceLine = lines[j] ?? '';
    if (fenceLine.trim() !== '```yaml') {
      throw new Error(
        `pack-example marker at line ${i + 1} not followed by a \`\`\`yaml fence (got ${JSON.stringify(fenceLine)})`,
      );
    }
    // Walk to the closing fence.
    const start = j + 1;
    let k = start;
    while (k < lines.length && lines[k]?.trim() !== '```') k += 1;
    if (k >= lines.length) {
      throw new Error(`pack-example at line ${i + 1} has no closing fence`);
    }
    examples.push({
      yaml: lines.slice(start, k).join('\n'),
      lineNumber: j + 1,
    });
    i = k;
  }
  return examples;
}

describe('docs/guides/packs.md examples', () => {
  const markdown = readFileSync(GUIDE_PATH, 'utf8');
  const examples = extractTaggedYamlExamples(markdown);

  it('the guide contains at least one pinned example', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  for (const example of examples) {
    it(`example at line ${example.lineNumber} parses against PackManifestSchema`, () => {
      const result = parsePackManifest(example.yaml);
      if (!result.ok) {
        const yamlLoc = result.line !== undefined ? ` (yaml line ${result.line})` : '';
        throw new Error(
          `example at line ${example.lineNumber} failed to parse: ${result.error}${yamlLoc}`,
        );
      }
      // Non-empty memories array is enforced by the schema; sanity
      // check it surfaces in the parsed manifest so a regressing
      // schema can't accidentally let an empty pack land in the
      // guide.
      expect(result.manifest.memories.length).toBeGreaterThan(0);
    });
  }
});
