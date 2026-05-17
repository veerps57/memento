// Tests for `init-prompts.ts` — the interactive-prompt test seam
// for `memento init` (ADR-0028).
//
// The scripted prompter is tested directly. The production
// prompter (`createClackInitPrompter`) wraps `@clack/prompts`;
// we mock that module with `vi.mock` so the branches inside the
// production wrapper get exercised without needing a real TTY.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @clack/prompts before importing the module under test.
// Each prompt's response is settable per-test via the exported
// `mockClack` helper.
vi.mock('@clack/prompts', () => {
  const cancelSymbol = Symbol.for('clack:cancel');
  const state = {
    textResponse: '' as string | symbol,
    confirmResponse: true as boolean | symbol,
    selectResponse: '' as string | symbol,
  };
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn(async () => state.textResponse),
    confirm: vi.fn(async () => state.confirmResponse),
    select: vi.fn(async () => state.selectResponse),
    isCancel: (value: unknown) => value === cancelSymbol,
    __state: state,
    __cancelSymbol: cancelSymbol,
  };
});

import * as clackMock from '@clack/prompts';

import {
  createClackInitPrompter,
  createScriptedInitPrompter,
} from '../src/lifecycle/init-prompts.js';

// Reach into the mock to set per-test responses.
const mockState = (
  clackMock as unknown as {
    __state: {
      textResponse: string | symbol;
      confirmResponse: boolean | symbol;
      selectResponse: string | symbol;
    };
  }
).__state;
const cancelSymbol = (clackMock as unknown as { __cancelSymbol: symbol }).__cancelSymbol;

beforeEach(() => {
  mockState.textResponse = '';
  mockState.confirmResponse = true;
  mockState.selectResponse = '';
});

describe('createScriptedInitPrompter', () => {
  it('returns "skip" outcomes by default when no script entries are supplied', async () => {
    const prompter = createScriptedInitPrompter();
    expect(await prompter.promptPreferredName(null)).toEqual({ kind: 'skip' });
    expect(await prompter.promptInstallSkill({ sourcePath: '/x', targetDir: '/y' })).toEqual({
      kind: 'skip',
    });
    expect(await prompter.promptStarterPack([{ id: 'p', title: 't' }])).toEqual({
      kind: 'skip',
    });
  });

  it('honours each scripted answer independently', async () => {
    const prompter = createScriptedInitPrompter({
      preferredName: { kind: 'set', value: 'Raghu' },
      installSkill: { kind: 'install' },
      starterPack: { kind: 'install', packId: 'engineering-simplicity' },
    });
    expect(await prompter.promptPreferredName(null)).toEqual({
      kind: 'set',
      value: 'Raghu',
    });
    expect(await prompter.promptInstallSkill({ sourcePath: '/x', targetDir: '/y' })).toEqual({
      kind: 'install',
    });
    expect(await prompter.promptStarterPack([{ id: 'p', title: 't' }])).toEqual({
      kind: 'install',
      packId: 'engineering-simplicity',
    });
  });

  it('emits each cancellation outcome verbatim', async () => {
    // Cover the alternative-shape branches each method can return,
    // so refactoring the kind union later trips a clear failure.
    const prompter = createScriptedInitPrompter({
      preferredName: { kind: 'cancelled' },
      installSkill: { kind: 'cancelled' },
      starterPack: { kind: 'cancelled' },
    });
    expect((await prompter.promptPreferredName(null)).kind).toBe('cancelled');
    expect((await prompter.promptInstallSkill({ sourcePath: '/x', targetDir: '/y' })).kind).toBe(
      'cancelled',
    );
    expect((await prompter.promptStarterPack([{ id: 'p', title: 't' }])).kind).toBe('cancelled');
  });

  it('supports the "already-current" skill-install outcome', async () => {
    // Tests can pre-bake the already-current outcome to short-circuit
    // the install branch — useful when verifying that callers honor
    // it without copying any files.
    const prompter = createScriptedInitPrompter({
      installSkill: { kind: 'already-current' },
    });
    expect((await prompter.promptInstallSkill({ sourcePath: '/x', targetDir: '/y' })).kind).toBe(
      'already-current',
    );
  });
});

describe('createClackInitPrompter', () => {
  it('exposes the four prompt methods plus intro/outro hooks', () => {
    const prompter = createClackInitPrompter();
    expect(typeof prompter.promptPreferredName).toBe('function');
    expect(typeof prompter.promptInstallSkill).toBe('function');
    expect(typeof prompter.promptStarterPack).toBe('function');
    expect(typeof prompter.promptInstallPersona).toBe('function');
    expect(typeof prompter.intro).toBe('function');
    expect(typeof prompter.outro).toBe('function');
  });

  describe('promptPreferredName', () => {
    it('returns "set" when the user types a non-empty new name', async () => {
      mockState.textResponse = 'Raghu';
      const prompter = createClackInitPrompter();
      expect(await prompter.promptPreferredName(null)).toEqual({ kind: 'set', value: 'Raghu' });
    });

    it('returns "skip" when the user presses Enter on an empty input', async () => {
      mockState.textResponse = '';
      const prompter = createClackInitPrompter();
      expect(await prompter.promptPreferredName(null)).toEqual({ kind: 'skip' });
    });

    it('returns "skip" when the user re-enters the existing value (no-op)', async () => {
      mockState.textResponse = 'Raghu';
      const prompter = createClackInitPrompter();
      expect(await prompter.promptPreferredName('Raghu')).toEqual({ kind: 'skip' });
    });

    it('returns "cancelled" when the user interrupts the prompt', async () => {
      mockState.textResponse = cancelSymbol;
      const prompter = createClackInitPrompter();
      expect(await prompter.promptPreferredName(null)).toEqual({ kind: 'cancelled' });
    });

    it('trims surrounding whitespace from the typed value', async () => {
      mockState.textResponse = '  Raghu  ';
      const prompter = createClackInitPrompter();
      expect(await prompter.promptPreferredName(null)).toEqual({ kind: 'set', value: 'Raghu' });
    });
  });

  describe('promptInstallSkill', () => {
    it('returns "install" when the user confirms', async () => {
      mockState.confirmResponse = true;
      const prompter = createClackInitPrompter();
      expect(await prompter.promptInstallSkill({ sourcePath: '/x', targetDir: '/y' })).toEqual({
        kind: 'install',
      });
    });

    it('returns "skip" when the user declines', async () => {
      mockState.confirmResponse = false;
      const prompter = createClackInitPrompter();
      expect(await prompter.promptInstallSkill({ sourcePath: '/x', targetDir: '/y' })).toEqual({
        kind: 'skip',
      });
    });

    it('returns "cancelled" on user interrupt', async () => {
      mockState.confirmResponse = cancelSymbol;
      const prompter = createClackInitPrompter();
      expect(await prompter.promptInstallSkill({ sourcePath: '/x', targetDir: '/y' })).toEqual({
        kind: 'cancelled',
      });
    });
  });

  describe('promptStarterPack', () => {
    it('returns "install" with the picked packId', async () => {
      mockState.selectResponse = 'engineering-simplicity';
      const prompter = createClackInitPrompter();
      expect(
        await prompter.promptStarterPack([
          { id: 'engineering-simplicity', title: 't1' },
          { id: 'pragmatic-programmer', title: 't2' },
        ]),
      ).toEqual({ kind: 'install', packId: 'engineering-simplicity' });
    });

    it('returns "skip" when the user picks the skip sentinel', async () => {
      mockState.selectResponse = '__skip__';
      const prompter = createClackInitPrompter();
      expect(
        await prompter.promptStarterPack([{ id: 'engineering-simplicity', title: 't' }]),
      ).toEqual({ kind: 'skip' });
    });

    it('returns "cancelled" on user interrupt', async () => {
      mockState.selectResponse = cancelSymbol;
      const prompter = createClackInitPrompter();
      expect(
        await prompter.promptStarterPack([{ id: 'engineering-simplicity', title: 't' }]),
      ).toEqual({ kind: 'cancelled' });
    });
  });

  it('intro and outro hooks invoke the corresponding clack helpers', () => {
    const prompter = createClackInitPrompter();
    prompter.intro?.('hello');
    prompter.outro?.('bye');
    expect(clackMock.intro).toHaveBeenCalledWith('hello');
    expect(clackMock.outro).toHaveBeenCalledWith('bye');
  });
});
