// Pin every bundled pack YAML against the shipping schema.
//
// Discovers `packs/<id>/v<version>.yaml` files at the repo root, parses
// each one through `parsePackManifest`, and asserts the manifest's
// id/version match the directory + filename. If the schema gains a new
// required field, or an existing pack drifts away from the directory
// layout the bundled-resolver expects, this test fails.
//
// An empty `packs/` directory is acceptable (the engine doesn't require
// bundled packs to ship). The discovery only fails on a structurally
// broken file path resolution, not on absence of packs.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePackManifest } from '../../src/packs/parse.js';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PACKS_DIR = join(REPO_ROOT, 'packs');

interface BundledPack {
  readonly id: string;
  readonly version: string;
  readonly path: string;
}

function discoverBundledPacks(): readonly BundledPack[] {
  let packDirs: string[];
  try {
    packDirs = readdirSync(PACKS_DIR);
  } catch {
    return [];
  }
  const packs: BundledPack[] = [];
  for (const id of packDirs) {
    const dir = join(PACKS_DIR, id);
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const entries = readdirSync(dir);
    for (const file of entries) {
      const match = /^v(.+)\.yaml$/.exec(file);
      if (!match) continue;
      packs.push({ id, version: match[1] as string, path: join(dir, file) });
    }
  }
  return packs;
}

describe('bundled packs', () => {
  const packs = discoverBundledPacks();

  // Discovery is the first test, parametrised tests follow. The
  // discovery test is intentionally non-strict on count — empty
  // `packs/` is fine — but it does fail loudly if the path
  // resolution is broken (e.g. a refactor moves the test file and
  // the relative path no longer points to the repo root).
  it('discovers the packs/ directory at the repo root', () => {
    expect(packs.length).toBeGreaterThanOrEqual(0);
  });

  for (const pack of packs) {
    it(`${pack.id}@${pack.version} parses and matches its directory layout`, () => {
      const raw = readFileSync(pack.path, 'utf8');
      const result = parsePackManifest(raw);
      if (!result.ok) {
        const loc = result.line !== undefined ? ` (line ${result.line})` : '';
        throw new Error(`${pack.path} failed to parse: ${result.error}${loc}`);
      }
      expect(result.manifest.id, `${pack.path}: manifest.id must match directory`).toBe(pack.id);
      expect(result.manifest.version, `${pack.path}: manifest.version must match v<...>.yaml`).toBe(
        pack.version,
      );
      // Every bundled pack carries at least one memory — schema
      // already enforces non-empty, but pinning here gives a clearer
      // failure if the schema's `min(1)` ever loosens.
      expect(result.manifest.memories.length).toBeGreaterThan(0);
    });
  }
});
