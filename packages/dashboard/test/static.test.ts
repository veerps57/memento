// `resolveDashboardUiDir` resolver tests.
//
// The resolver walks up from a starting directory looking for
// `dist-ui/index.html`. We exercise the ladder of probe depths
// against tmp filesystem layouts (no `node:fs` mocks) so the
// test surface matches what a real install sees on disk.
//
// Mirrors the pattern in `packages/cli/test/skill-source.test.ts`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveDashboardUiDir } from '../src/server/static.js';

describe('resolveDashboardUiDir', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmp(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'memento-dashboard-uidir-'));
    created.push(dir);
    return dir;
  }

  it('returns null when no ancestor has dist-ui/index.html', () => {
    const tmp = makeTmp();
    expect(resolveDashboardUiDir(tmp)).toBeNull();
  });

  it('returns the closest ancestor that has dist-ui/index.html', () => {
    const tmp = makeTmp();
    const uiDir = path.join(tmp, 'dist-ui');
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html>');

    const origin = path.join(tmp, 'pkg');
    mkdirSync(origin, { recursive: true });
    expect(resolveDashboardUiDir(origin)).toBe(uiDir);
  });

  it('walks up to depth 4 to find the bundle', () => {
    const tmp = makeTmp();
    const uiDir = path.join(tmp, 'dist-ui');
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html>');

    // origin is four levels deep; resolver should still find it.
    const origin = path.join(tmp, 'a', 'b', 'c', 'd');
    mkdirSync(origin, { recursive: true });
    expect(resolveDashboardUiDir(origin)).toBe(uiDir);
  });

  it('returns null when the bundle is past the depth-4 probe budget', () => {
    const tmp = makeTmp();
    const uiDir = path.join(tmp, 'dist-ui');
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html>');

    // origin five levels deep — out of the probe budget.
    const origin = path.join(tmp, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(origin, { recursive: true });
    expect(resolveDashboardUiDir(origin)).toBeNull();
  });

  it('treats a directory missing index.html as not-found (presence is the marker)', () => {
    // A `dist-ui/` directory with no `index.html` is a half-built
    // state — possible if someone aborted `vite build` mid-way.
    // The resolver only counts a directory as the bundle when
    // `index.html` is present.
    const tmp = makeTmp();
    mkdirSync(path.join(tmp, 'dist-ui'), { recursive: true });
    expect(resolveDashboardUiDir(tmp)).toBeNull();
  });

  it('uses the module location when no originDir is supplied', () => {
    // No-arg path: returns either the staged `dist-ui/` from the
    // last build or null. We don't pin the exact path because the
    // suite must work whether `pnpm build` ran beforehand or not;
    // we only assert the contract that null is the absence signal.
    const result = resolveDashboardUiDir();
    if (result !== null) {
      expect(path.basename(result)).toBe('dist-ui');
    }
  });
});
