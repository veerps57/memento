// Resolve where the bundled Memento skill source lives on the
// running install.
//
// Why this exists
// ---------------
//
// `memento init` surfaces the Memento skill bundle to clients
// that support Anthropic skills (Claude Code, Claude Desktop,
// Cowork). For the surfaced path to be usable verbatim, the
// renderer needs an absolute filesystem path that exists on the
// user's machine — not a docs URL, not an `npm root` lookup the
// user has to run themselves.
//
// The skill source is staged by `scripts/copy-skills.mjs` at
// `<package-root>/skills/memento/` during every CLI build. The
// resolver walks up from `import.meta.url` looking for that
// `skills/memento/SKILL.md`, returning `null` when not bundled
// (e.g. a dev environment that has not yet run `pnpm build`).
// `null` is a first-class signal: the renderer falls back to a
// docs link in that case rather than printing a broken path.
//
// The probe walks up multiple levels because the CLI ships from
// two layouts: the bundled `<package>/dist/cli.js` (production)
// and the in-source `<package>/src/lifecycle/init.ts` (tests
// importing the source directly). Both must resolve to the same
// `<package>/skills/memento/`.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the staged Memento skill source on the
 * running install, or `null` if the skill is not bundled.
 *
 * Callers that produce user-facing instructions should treat
 * `null` as "fall back to a docs link"; do not invent a path.
 *
 * @param originDir Override for the search origin. Defaults to
 *   the directory containing this module file (the production
 *   call path). Tests pass a tmp directory so the resolver can
 *   be exercised against a controlled filesystem layout without
 *   mocking `node:fs`.
 */
export function resolveSkillSourceDir(originDir?: string): string | null {
  const here = originDir ?? path.dirname(fileURLToPath(import.meta.url));
  // Walk up to four levels searching for the staged skill. The
  // upper bound is set by the deepest source path we ship from
  // (`src/lifecycle/init.ts` — three levels under
  // `<package-root>/`). Bundled `dist/cli.js` resolves at depth 1.
  for (let depth = 1; depth <= 4; depth += 1) {
    const ascent = Array.from({ length: depth }, () => '..');
    const candidate = path.resolve(here, ...ascent, 'skills', 'memento');
    if (existsSync(path.join(candidate, 'SKILL.md'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Suggested target directory for installing the skill, suitable
 * for surfacing in `memento init`'s walkthrough. Platform-aware:
 * Claude Code reads from `~/.claude/skills/` on every OS, but
 * `~` is shell-expanded by the user's shell, so the renderer
 * gets to decide whether to print the literal `~` form or the
 * fully-expanded `os.homedir()` form.
 *
 * The path is for display only — `init` is print-only by
 * design (see `init.ts` header). A future `--install-skill`
 * flag may consume this value.
 */
export function suggestedSkillTargetDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}
