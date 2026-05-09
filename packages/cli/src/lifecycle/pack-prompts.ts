// Interactive review prompter for `memento pack create`.
//
// `runCreate` enters interactive mode when stdin is a TTY and the
// caller passed no filter flags (per ADR-0020 §Authoring). In that
// mode it lists every memory matching the scope filter and asks
// the user to keep or skip each one — the result is the kept
// subset that `buildManifestFromMemories` then bundles.
//
// The {@link PackCreatePrompter} interface is the test seam. The
// production factory wraps `@clack/prompts` (text/select/confirm
// terminal UI). Tests inject {@link createScriptedPrompter} which
// returns canned answers. The CLI never imports `@clack/prompts`
// outside this file, so no test ever spins up a real TTY.

import * as clack from '@clack/prompts';

import type { ReviewMemoryItem } from './pack-types.js';

export interface PackReviewOutcome {
  readonly kind: 'keep' | 'cancelled';
  /** Populated only when `kind === 'keep'`. Subset of the supplied items in the same order. */
  readonly kept?: readonly ReviewMemoryItem[];
}

export interface PackCreateConfirmOutcome {
  readonly kind: 'confirm' | 'cancelled';
  readonly confirmed?: boolean;
}

export interface PackCreatePrompter {
  /**
   * Walk the user through every supplied memory and decide
   * keep/skip per row. Returns the kept subset (in original order)
   * or `cancelled` when the user aborts (Ctrl-C or `Escape`).
   */
  reviewMemories(items: readonly ReviewMemoryItem[]): Promise<PackReviewOutcome>;
  /**
   * Final yes/no gate before writing the YAML file. Returns
   * `confirmed: true` to proceed, `false` to abort, or `cancelled`
   * on user interrupt.
   */
  confirmWrite(summary: { keptCount: number; outPath: string }): Promise<PackCreateConfirmOutcome>;
  /**
   * Optional structured intro shown at the start of the
   * interactive flow. Production renders a heading; tests usually
   * no-op.
   */
  intro?(message: string): void;
  /**
   * Optional structured outro shown after the file is written.
   */
  outro?(message: string): void;
}

/**
 * Production prompter — wraps `@clack/prompts`. Each prompt
 * checks for the cancellation symbol and converts it to the
 * `cancelled` outcome so callers never see the symbol.
 */
export function createClackPrompter(): PackCreatePrompter {
  return {
    intro(message) {
      clack.intro(message);
    },
    outro(message) {
      clack.outro(message);
    },
    async reviewMemories(items) {
      const kept: ReviewMemoryItem[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item === undefined) continue;
        const response = await clack.select({
          message: renderReviewPrompt(item, i, items.length),
          options: [
            { value: 'keep' as const, label: 'Keep' },
            { value: 'skip' as const, label: 'Skip' },
          ],
        });
        if (clack.isCancel(response)) {
          return { kind: 'cancelled' };
        }
        if (response === 'keep') kept.push(item);
      }
      return { kind: 'keep', kept };
    },
    async confirmWrite({ keptCount, outPath }) {
      const response = await clack.confirm({
        message: `Write ${keptCount} memor${keptCount === 1 ? 'y' : 'ies'} to ${outPath}?`,
      });
      if (clack.isCancel(response)) {
        return { kind: 'cancelled' };
      }
      return { kind: 'confirm', confirmed: response };
    },
  };
}

function renderReviewPrompt(item: ReviewMemoryItem, index: number, total: number): string {
  const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
  const preview = item.content.length > 120 ? `${item.content.slice(0, 120)}…` : item.content;
  return `[${index + 1}/${total}] ${item.kind}${tags}\n  ${preview}`;
}

/**
 * Test prompter — returns canned answers from a script. Each
 * call to `reviewMemories` or `confirmWrite` consumes one
 * scripted answer and asserts it has the right shape; running
 * out of script entries is a programmer error and throws.
 *
 * The script is ordered: review-decisions first (one decision
 * per memory item), then a single confirm-write answer. Tests
 * that don't reach `confirmWrite` simply omit the trailing
 * confirm entry.
 */
export interface ScriptedAnswers {
  /** One decision per memory in `reviewMemories`. */
  readonly review?: ReadonlyArray<'keep' | 'skip' | 'cancel'>;
  /** Decision for the trailing `confirmWrite`. */
  readonly confirm?: 'yes' | 'no' | 'cancel';
}

export function createScriptedPrompter(script: ScriptedAnswers): PackCreatePrompter {
  return {
    async reviewMemories(items) {
      const decisions = script.review ?? [];
      if (decisions.length !== items.length) {
        throw new Error(
          `scripted prompter: review script has ${decisions.length} entries but ${items.length} items were supplied`,
        );
      }
      const kept: ReviewMemoryItem[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const decision = decisions[i];
        const item = items[i];
        if (decision === 'cancel') return { kind: 'cancelled' };
        if (decision === 'keep' && item !== undefined) kept.push(item);
      }
      return { kind: 'keep', kept };
    },
    async confirmWrite() {
      const answer = script.confirm;
      if (answer === undefined) {
        throw new Error(
          'scripted prompter: confirmWrite was reached but no confirm answer was supplied',
        );
      }
      if (answer === 'cancel') return { kind: 'cancelled' };
      return { kind: 'confirm', confirmed: answer === 'yes' };
    },
  };
}
