// `memento skill-path` — print the absolute path of the staged
// Memento skill bundle on stdout.
//
// Why this exists
// ---------------
//
// `memento init`'s walkthrough prints the install command for the
// Memento skill (any client that loads Anthropic-format skills)
// with the resolved absolute path baked in. That path varies by
// install
// method — `~/.npm/_npx/<hash>/...` for `npx`, the global prefix
// for `npm i -g`, the workspace path for a clone — so docs and
// the landing page cannot hardcode it.
//
// `skill-path` is the path-only sibling. It prints exactly one
// line on stdout: the absolute path. Designed for shell embedding:
//
//   cp -R "$(memento skill-path)" ~/.claude/skills/
//
// Failure mode (`source` not bundled — typically a dev checkout
// that has not run `pnpm build`) returns `NOT_FOUND` so scripts
// can branch on `$?`. The `details.suggestedTarget` field still
// surfaces the install destination for messaging.
//
// Stays a CLI-only lifecycle command (no MCP projection) because
// the value is filesystem-local and only useful to a shell.

import { type Result, err, ok } from '@psraghuveer/memento-schema';

import { resolveSkillSourceDir, suggestedSkillTargetDir } from '../skill-source.js';
import type { LifecycleCommand, LifecycleDeps, LifecycleInput } from './types.js';

/** Stable contract for `memento skill-path`. */
export interface SkillPathSnapshot {
  /** Absolute path to the staged skill source. */
  readonly source: string;
  /** Suggested install target (`~/.claude/skills/`, expanded). */
  readonly suggestedTarget: string;
}

export const skillPathCommand: LifecycleCommand = {
  name: 'skill-path',
  description: 'Print the absolute path of the bundled Memento skill (for $(…) shell embedding)',
  run: runSkillPath,
};

export async function runSkillPath(
  _deps: LifecycleDeps,
  input: LifecycleInput,
): Promise<Result<SkillPathSnapshot>> {
  if (input.subargs.length > 0) {
    return err({
      code: 'INVALID_INPUT',
      message: `skill-path takes no arguments (got: ${input.subargs.join(' ')})`,
    });
  }
  const suggestedTarget = suggestedSkillTargetDir();
  const source = resolveSkillSourceDir();
  if (source === null) {
    // Dev checkout that has not run `pnpm build`, or a corrupted
    // install where the tarball did not ship `skills/`. Surface
    // the install target so the caller can still print a useful
    // message; do NOT invent a path.
    return err({
      code: 'NOT_FOUND',
      message:
        'Memento skill bundle is not staged on this install. ' +
        'Run `pnpm build` from a clone, or reinstall the package — the skill ships under <package>/skills/memento/.',
      details: { suggestedTarget },
    });
  }
  return ok({ source, suggestedTarget });
}
