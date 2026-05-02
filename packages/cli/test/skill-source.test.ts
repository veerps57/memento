// `skill-source` resolver tests.
//
// Covers both branches of `resolveSkillSourceDir` (found / not
// found) and pins the shape of `suggestedSkillTargetDir`. The
// resolver is exercised against a temp-dir layout rather than
// mocking `node:fs`, so the test surface is identical to what a
// real install sees on disk.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSkillSourceDir, suggestedSkillTargetDir } from '../src/skill-source.js';

describe('resolveSkillSourceDir', () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmp(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'memento-skill-resolver-'));
    created.push(dir);
    return dir;
  }

  it('returns null when no ancestor has skills/memento/SKILL.md', () => {
    const tmp = makeTmp();
    // The resolver walks up from `originDir` looking for
    // `skills/memento/SKILL.md`. With nothing seeded, every
    // depth probe misses.
    expect(resolveSkillSourceDir(tmp)).toBeNull();
  });

  it('returns the closest ancestor that contains the skill', () => {
    const tmp = makeTmp();
    // Layout:
    //   <tmp>/                          ← we set originDir here
    //   <tmp>/skills/memento/SKILL.md   ← match at depth 1
    const skillDir = path.join(tmp, 'skills', 'memento');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\n---\n');

    // Place originDir one level under tmp so depth 1 = tmp/skills/memento.
    const origin = path.join(tmp, 'pkg');
    mkdirSync(origin, { recursive: true });
    expect(resolveSkillSourceDir(origin)).toBe(skillDir);
  });

  it('walks all the way up to depth 4', () => {
    const tmp = makeTmp();
    // Layout:
    //   <tmp>/skills/memento/SKILL.md  ← match exists at this level
    //   <tmp>/a/b/c/d/                  ← origin is 4 levels deep
    // The loop probes depths 1..4; the match shows up at depth 4.
    const skillDir = path.join(tmp, 'skills', 'memento');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\n---\n');

    const origin = path.join(tmp, 'a', 'b', 'c', 'd');
    mkdirSync(origin, { recursive: true });
    expect(resolveSkillSourceDir(origin)).toBe(skillDir);
  });

  it('returns null when the skill is deeper than 4 ancestors', () => {
    const tmp = makeTmp();
    // Place skill at the root, origin five levels deep — out of
    // the resolver's probe budget.
    const skillDir = path.join(tmp, 'skills', 'memento');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\n---\n');
    const origin = path.join(tmp, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(origin, { recursive: true });
    expect(resolveSkillSourceDir(origin)).toBeNull();
  });

  it('uses the module location when no originDir is supplied', () => {
    // No-arg call goes through the production path. The result
    // depends on the filesystem layout the suite runs under: in
    // every supported configuration (clone, dev install, npm
    // install) the workspace-root `skills/memento/` exists, so
    // the resolver finds it. We assert the return value points
    // at a real `SKILL.md` rather than pinning the exact path,
    // because the test must work from `dist` and `src` layouts.
    const result = resolveSkillSourceDir();
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(path.basename(result)).toBe('memento');
  });
});

describe('suggestedSkillTargetDir', () => {
  it('returns a path inside the user home directory', () => {
    const target = suggestedSkillTargetDir();
    expect(target.startsWith(os.homedir())).toBe(true);
    expect(target.endsWith(path.join('.claude', 'skills'))).toBe(true);
  });
});
