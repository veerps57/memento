// Unit tests for the test-only `createScriptedPrompter`. The
// production `createClackPrompter` is exercised through e2e
// integration; here we pin the scripted-prompter contract that
// every interactive lifecycle test relies on.

import { describe, expect, it } from 'vitest';

import { createScriptedPrompter } from '../src/lifecycle/pack-prompts.js';
import type { ReviewMemoryItem } from '../src/lifecycle/pack-types.js';

const item = (id: string): ReviewMemoryItem => ({
  id,
  kind: 'fact',
  content: `content for ${id}`,
  tags: [],
});

describe('createScriptedPrompter', () => {
  describe('reviewMemories', () => {
    it('keeps every item flagged `keep` and drops every `skip`', async () => {
      const prompter = createScriptedPrompter({
        review: ['keep', 'skip', 'keep'],
      });
      const result = await prompter.reviewMemories([item('a'), item('b'), item('c')]);
      expect(result.kind).toBe('keep');
      if (result.kind !== 'keep') return;
      expect(result.kept?.map((k) => k.id)).toEqual(['a', 'c']);
    });

    it('returns `cancelled` when the script encounters a `cancel` decision', async () => {
      const prompter = createScriptedPrompter({
        review: ['keep', 'cancel', 'keep'],
      });
      const result = await prompter.reviewMemories([item('a'), item('b'), item('c')]);
      expect(result.kind).toBe('cancelled');
    });

    it('throws when the script length does not match the items length', async () => {
      const prompter = createScriptedPrompter({ review: ['keep'] });
      await expect(prompter.reviewMemories([item('a'), item('b')])).rejects.toThrow(
        /review script has 1/,
      );
    });

    it('returns no kept items when an empty script is supplied to an empty input', async () => {
      const prompter = createScriptedPrompter({ review: [] });
      const result = await prompter.reviewMemories([]);
      expect(result.kind).toBe('keep');
      if (result.kind !== 'keep') return;
      expect(result.kept).toEqual([]);
    });
  });

  describe('confirmWrite', () => {
    it('returns confirmed: true on `yes`', async () => {
      const prompter = createScriptedPrompter({ confirm: 'yes' });
      const result = await prompter.confirmWrite({ keptCount: 3, outPath: '/tmp/x.yaml' });
      expect(result.kind).toBe('confirm');
      if (result.kind !== 'confirm') return;
      expect(result.confirmed).toBe(true);
    });

    it('returns confirmed: false on `no`', async () => {
      const prompter = createScriptedPrompter({ confirm: 'no' });
      const result = await prompter.confirmWrite({ keptCount: 0, outPath: '-' });
      expect(result.kind).toBe('confirm');
      if (result.kind !== 'confirm') return;
      expect(result.confirmed).toBe(false);
    });

    it('returns cancelled on `cancel`', async () => {
      const prompter = createScriptedPrompter({ confirm: 'cancel' });
      const result = await prompter.confirmWrite({ keptCount: 1, outPath: '/tmp/y' });
      expect(result.kind).toBe('cancelled');
    });

    it('throws when confirmWrite is reached but no script entry was provided', async () => {
      const prompter = createScriptedPrompter({});
      await expect(prompter.confirmWrite({ keptCount: 1, outPath: '/tmp/y' })).rejects.toThrow(
        /no confirm answer/,
      );
    });
  });
});
