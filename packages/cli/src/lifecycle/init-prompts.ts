// Interactive prompts for `memento init`.
//
// ADR-0028: `init` enters interactive mode on a TTY and asks the
// user three y/N questions after the pre-flight checks pass —
// preferredName, install-skill, starter-pack. Each prompt
// closes one of the post-install drop-offs that historically
// kept first-time installs in a half-set-up state.
//
// The {@link InitPrompter} interface is the test seam, mirroring
// the pattern used by `pack-prompts.ts`. The production factory
// wraps `@clack/prompts`; tests inject a scripted prompter that
// returns canned answers without touching a real TTY.
//
// Production never imports `@clack/prompts` outside this file,
// so no test ever spins up a real terminal UI.

import * as clack from '@clack/prompts';

/**
 * Outcome of the preferredName prompt. `set` means the user
 * supplied a non-empty name (in `value`); `skip` means they
 * accepted the prompt and entered nothing (or kept the existing
 * value when already configured); `cancelled` means Ctrl-C or
 * Escape — the caller should stop the interactive flow but the
 * already-completed `init` work still applies.
 */
export interface PreferredNameOutcome {
  readonly kind: 'set' | 'skip' | 'cancelled';
  readonly value?: string;
}

/**
 * Outcome of the install-skill prompt. `install` means run
 * `cp -R <source> <target>/`; `skip` means leave the skills
 * directory alone; `already-current` is returned without
 * prompting when the bundled source matches the installed copy
 * by `SKILL.md` byte equality. `cancelled` means user interrupt.
 */
export interface InstallSkillOutcome {
  readonly kind: 'install' | 'skip' | 'already-current' | 'cancelled';
}

/**
 * One entry in the starter-pack picker — the user sees the
 * pack's id and title, and may pick at most one.
 */
export interface StarterPackChoice {
  readonly id: string;
  readonly title: string;
}

/**
 * Outcome of the starter-pack prompt. `install` carries the
 * picked `packId`; `skip` means the user declined; `cancelled`
 * means user interrupt.
 */
export interface StarterPackOutcome {
  readonly kind: 'install' | 'skip' | 'cancelled';
  readonly packId?: string;
}

/**
 * One client surfaced by the persona-install prompt's enumeration.
 * The prompt shows the user what would be auto-written (file-kind
 * targets) and what they'd need to paste manually (ui-kind
 * targets) before asking for consent.
 */
export interface PersonaInstallTargetSummary {
  readonly displayName: string;
  readonly kind: 'file' | 'ui';
  /** Resolved file path (kind=file) or human-readable UI path (kind=ui). */
  readonly path: string;
}

/**
 * Outcome of the persona-install prompt. `install` means the
 * user consented to auto-writing the file-based targets; `skip`
 * means they declined; `cancelled` means user interrupt.
 *
 * The actual install (marker-wrapped append-or-replace) happens
 * in `runInit` after the prompt returns — see
 * `packages/cli/src/persona-installer.ts`.
 */
export interface InstallPersonaOutcome {
  readonly kind: 'install' | 'skip' | 'cancelled';
}

/**
 * Test seam for the three interactive prompts. The production
 * implementation in {@link createClackInitPrompter} wraps the
 * `@clack/prompts` UI; tests pass a scripted prompter that
 * returns canned answers without touching a TTY.
 *
 * All three methods are independently called by `runInit`; a
 * prompter that returns `cancelled` from one prompt stops the
 * interactive flow but does not abort the entire `init` command
 * — the already-completed snapshot still flows through the
 * renderer, just without the cancelled section's outcome
 * applied.
 */
export interface InitPrompter {
  /**
   * Ask for the user's preferred display name (e.g. "Raghu").
   * `existing` is the current `user.preferredName` config value
   * (null when unset). The production prompt shows `existing`
   * as the default input value so a quick Enter keeps the
   * current state.
   */
  promptPreferredName(existing: string | null): Promise<PreferredNameOutcome>;
  /**
   * Ask whether to install the bundled Memento skill into the
   * target directory. `sourcePath` and `targetDir` are
   * display-only — the actual `cp -R` happens after the prompt
   * returns `install`.
   */
  promptInstallSkill(opts: {
    sourcePath: string;
    targetDir: string;
  }): Promise<InstallSkillOutcome>;
  /**
   * Ask which (if any) of the supplied starter packs to install
   * into the user's store. `choices` is non-empty; the prompt
   * adds a "Skip" option at the bottom so the user can decline
   * without picking one.
   */
  promptStarterPack(choices: readonly StarterPackChoice[]): Promise<StarterPackOutcome>;
  /**
   * Ask whether to auto-install the Memento persona snippet into
   * the user-scope custom-instructions files for the AI clients
   * detected on this machine. `fileTargets` enumerates files that
   * will be written with marker-wrapped, idempotent blocks;
   * `uiTargets` enumerates clients whose persona slot is UI-only
   * and require a manual copy-paste step (the renderer prints the
   * UI paths regardless of this prompt's outcome).
   *
   * The prompt is suppressed entirely when both lists are empty —
   * no detected clients, no question to ask.
   */
  promptInstallPersona(opts: {
    readonly fileTargets: readonly PersonaInstallTargetSummary[];
    readonly uiTargets: readonly PersonaInstallTargetSummary[];
  }): Promise<InstallPersonaOutcome>;
  /**
   * Optional structured intro shown once before the prompt
   * sequence begins. Production renders a heading;  tests
   * usually no-op.
   */
  intro?(message: string): void;
  /**
   * Optional structured outro shown once after the last prompt.
   */
  outro?(message: string): void;
}

/**
 * Production prompter — wraps `@clack/prompts`. Each prompt
 * normalises the `clack` cancellation symbol to a `cancelled`
 * outcome so callers never see the symbol directly. Empty / null
 * answers map to `skip`, not error.
 */
export function createClackInitPrompter(): InitPrompter {
  return {
    intro(message) {
      clack.intro(message);
    },
    outro(message) {
      clack.outro(message);
    },
    async promptPreferredName(existing) {
      // Default keeps the existing value (so a quick Enter is a
      // no-op confirm) when one is already set; otherwise the
      // input is blank and Enter skips.
      const response = await clack.text({
        message: 'What should the assistant call you?',
        placeholder: existing ?? '(e.g. Raghu — press Enter to skip)',
        initialValue: existing ?? '',
        // Empty input is the "skip" path — never an error.
        validate: () => undefined,
      });
      if (clack.isCancel(response)) return { kind: 'cancelled' };
      const trimmed = (response ?? '').trim();
      if (trimmed.length === 0) return { kind: 'skip' };
      // Quick-Enter on an already-set value re-supplies the same
      // string. Treat that as `skip` so we don't churn a config
      // write that changes nothing.
      if (existing !== null && trimmed === existing) return { kind: 'skip' };
      return { kind: 'set', value: trimmed };
    },
    async promptInstallSkill({ targetDir }) {
      const response = await clack.confirm({
        message: `Install the Memento skill into ${targetDir}?`,
        initialValue: true,
      });
      if (clack.isCancel(response)) return { kind: 'cancelled' };
      return response ? { kind: 'install' } : { kind: 'skip' };
    },
    async promptStarterPack(choices) {
      // Default to "Skip" rather than biasing toward any one
      // pack — Memento starts empty unless the user actively
      // picks something. Showing the skip option FIRST in the
      // select reinforces that picking is opt-in; a quick Enter
      // does nothing, which is the safe behaviour for a tool
      // about to write to the user's store. Pack picks remain
      // one keypress away (arrow-down + Enter).
      const SKIP = '__skip__' as const;
      const response = await clack.select({
        message:
          'Optionally seed your store with a starter pack (uninstall any time with `memento pack uninstall`):',
        initialValue: SKIP,
        options: [
          { value: SKIP, label: 'Skip — start empty (recommended)' },
          ...choices.map((choice) => ({
            value: choice.id,
            label: choice.id,
            hint: choice.title,
          })),
        ],
      });
      if (clack.isCancel(response)) return { kind: 'cancelled' };
      if (response === SKIP) return { kind: 'skip' };
      return { kind: 'install', packId: response as string };
    },
    async promptInstallPersona({ fileTargets, uiTargets }) {
      // Enumerate the user's detected clients so the consent
      // ask is concrete: "we'd write into these two files and
      // print a paste-instruction for these three." A vague
      // "install the persona snippet?" hides the actual file
      // writes from the user and would be presumptuous.
      const lines: string[] = [];
      lines.push('The persona snippet is the only teaching surface guaranteed to reach your');
      lines.push('assistant on every message. Auto-install it into your detected clients?');
      if (fileTargets.length > 0) {
        lines.push('');
        lines.push('Will write a marker-wrapped block to (idempotent, removable):');
        for (const target of fileTargets) lines.push(`  • ${target.path}  (${target.displayName})`);
      }
      if (uiTargets.length > 0) {
        lines.push('');
        lines.push('Print copy-paste instructions for (UI-only — you paste manually):');
        for (const target of uiTargets) {
          lines.push(`  • ${target.displayName} → ${target.path}`);
        }
      }
      const response = await clack.confirm({
        message: lines.join('\n'),
        initialValue: true,
      });
      if (clack.isCancel(response)) return { kind: 'cancelled' };
      return response ? { kind: 'install' } : { kind: 'skip' };
    },
  };
}

/**
 * Test prompter — returns canned answers from a script. Each
 * prompt method consumes one scripted answer; running out of
 * scripted entries is a programmer error and throws.
 *
 * Scripts are independent per prompt (preferredName, skill,
 * pack) so tests can exercise each in isolation. A prompt
 * method whose script slot is omitted falls through to `skip`
 * — the conservative default that mirrors a user pressing
 * Enter on every prompt.
 */
export interface InitScriptedAnswers {
  /** Override for `promptPreferredName`. */
  readonly preferredName?:
    | { readonly kind: 'set'; readonly value: string }
    | { readonly kind: 'skip' }
    | { readonly kind: 'cancelled' };
  /** Override for `promptInstallSkill`. */
  readonly installSkill?:
    | { readonly kind: 'install' }
    | { readonly kind: 'skip' }
    | { readonly kind: 'already-current' }
    | { readonly kind: 'cancelled' };
  /** Override for `promptStarterPack`. */
  readonly starterPack?:
    | { readonly kind: 'install'; readonly packId: string }
    | { readonly kind: 'skip' }
    | { readonly kind: 'cancelled' };
  /** Override for `promptInstallPersona`. */
  readonly installPersona?:
    | { readonly kind: 'install' }
    | { readonly kind: 'skip' }
    | { readonly kind: 'cancelled' };
}

export function createScriptedInitPrompter(script: InitScriptedAnswers = {}): InitPrompter {
  return {
    async promptPreferredName() {
      return script.preferredName ?? { kind: 'skip' };
    },
    async promptInstallSkill() {
      return script.installSkill ?? { kind: 'skip' };
    },
    async promptStarterPack() {
      return script.starterPack ?? { kind: 'skip' };
    },
    async promptInstallPersona() {
      return script.installPersona ?? { kind: 'skip' };
    },
  };
}
