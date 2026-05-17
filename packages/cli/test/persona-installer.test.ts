// Tests for `persona-installer.ts` — the auto-write of the
// Memento persona snippet into user-scope custom-instructions
// files (ADR-0028 follow-up).
//
// Covers:
//   - detection of file-based vs UI-only client targets via the
//     filesystem probe (sandboxed under a fresh tmpdir HOME so
//     the developer's real home isn't probed)
//   - the marker-wrapped append-or-replace on first install
//   - idempotency: re-install with identical content is no-op
//   - update path: re-install with different content splices the
//     block in place without churning surrounding user content
//   - uninstall: marker block stripped, other content untouched

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type PersonaTarget,
  detectPersonaTargets,
  installPersona,
  uninstallPersona,
} from '../src/persona-installer.js';

const FIXED_PERSONA = `## Memory (Memento)

This is a probe persona payload used by the persona-installer
unit tests. It's short, multi-line, and contains the kind of
markdown formatting (headers, list items, code spans like
\`get_memory_context\`) that real personas use.

- Always start with get_memory_context.
- Treat memory ops as silent plumbing.
- For preferences, use a \`topic: value\` first line.`;

const FIXED_VERSION = '0.9.0-test';

describe('detectPersonaTargets', () => {
  it('emits a Claude Code file target when ~/.claude/ exists', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'persona-detect-'));
    try {
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      const targets = detectPersonaTargets(home);
      const claudeCode = targets.find((t) => t.clientId === 'claude-code');
      expect(claudeCode?.kind).toBe('file');
      if (claudeCode?.kind === 'file') {
        expect(claudeCode.path).toBe(path.join(home, '.claude', 'CLAUDE.md'));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('emits an OpenCode file target when ~/.config/opencode/ exists', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'persona-detect-'));
    try {
      mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
      const targets = detectPersonaTargets(home);
      const opencode = targets.find((t) => t.clientId === 'opencode');
      expect(opencode?.kind).toBe('file');
      if (opencode?.kind === 'file') {
        expect(opencode.path).toBe(path.join(home, '.config', 'opencode', 'AGENTS.md'));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('emits a Cline file target when ~/Documents/Cline/ exists', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'persona-detect-'));
    try {
      mkdirSync(path.join(home, 'Documents', 'Cline'), { recursive: true });
      const targets = detectPersonaTargets(home);
      const cline = targets.find((t) => t.clientId === 'cline');
      expect(cline?.kind).toBe('file');
      if (cline?.kind === 'file') {
        expect(cline.path).toBe(path.join(home, 'Documents', 'Cline', 'Rules', 'memento.md'));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('always emits a UI-only target for Claude Chat (web/mobile)', () => {
    // Claude Chat at claude.ai web/mobile leaves no local
    // disk footprint, so we can't probe for it. The renderer's
    // copy-paste instructions are unconditional.
    const home = mkdtempSync(path.join(os.tmpdir(), 'persona-detect-'));
    try {
      const targets = detectPersonaTargets(home);
      const chat = targets.find((t) => t.clientId === 'claude-chat');
      expect(chat?.kind).toBe('ui');
      if (chat?.kind === 'ui') {
        expect(chat.uiPath).toMatch(/claude\.ai/i);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('emits Cowork as a UI-only target when Claude Code dir is present', () => {
    // Cowork is the Anthropic-product sibling of Claude Code on
    // Desktop. We surface it as a UI-only target whenever the
    // Claude Code dir is present, since both apps coexist.
    const home = mkdtempSync(path.join(os.tmpdir(), 'persona-detect-'));
    try {
      mkdirSync(path.join(home, '.claude'), { recursive: true });
      const targets = detectPersonaTargets(home);
      const cowork = targets.find((t) => t.clientId === 'cowork');
      expect(cowork?.kind).toBe('ui');
      if (cowork?.kind === 'ui') {
        expect(cowork.uiPath.toLowerCase()).toContain('cowork');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('installPersona', () => {
  function fileTarget(filePath: string): PersonaTarget {
    return {
      kind: 'file',
      clientId: 'claude-code',
      displayName: 'Claude Code',
      path: filePath,
    };
  }

  it('creates the file with marker-wrapped block on a fresh install', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'persona-install-'));
    try {
      const filePath = path.join(tmp, 'CLAUDE.md');
      const results = await installPersona({
        targets: [fileTarget(filePath)],
        personaContent: FIXED_PERSONA,
        version: FIXED_VERSION,
      });
      expect(results.length).toBe(1);
      expect(results[0]?.outcome.kind).toBe('installed');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('<!-- memento:persona BEGIN v0.9.0-test -->');
      expect(content).toContain('<!-- memento:persona END -->');
      expect(content).toContain('Memento');
      expect(content).toContain('get_memory_context');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves existing user content when appending the block', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'persona-append-'));
    try {
      const filePath = path.join(tmp, 'CLAUDE.md');
      const existing = '# Personal preferences\n\n- I prefer pnpm over npm.\n- Tabs over spaces.\n';
      writeFileSync(filePath, existing);
      const results = await installPersona({
        targets: [fileTarget(filePath)],
        personaContent: FIXED_PERSONA,
        version: FIXED_VERSION,
      });
      expect(results[0]?.outcome.kind).toBe('installed');
      const content = readFileSync(filePath, 'utf8');
      // User content survives.
      expect(content).toContain('I prefer pnpm over npm.');
      expect(content).toContain('Tabs over spaces.');
      // Memento block appended after it.
      expect(content.indexOf('Tabs over spaces.')).toBeLessThan(
        content.indexOf('memento:persona BEGIN'),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is idempotent — re-install with identical content reports already-current', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'persona-idemp-'));
    try {
      const filePath = path.join(tmp, 'CLAUDE.md');
      await installPersona({
        targets: [fileTarget(filePath)],
        personaContent: FIXED_PERSONA,
        version: FIXED_VERSION,
      });
      const before = readFileSync(filePath, 'utf8');
      const results = await installPersona({
        targets: [fileTarget(filePath)],
        personaContent: FIXED_PERSONA,
        version: FIXED_VERSION,
      });
      expect(results[0]?.outcome.kind).toBe('already-current');
      const after = readFileSync(filePath, 'utf8');
      // File contents byte-identical — no append, no churn.
      expect(after).toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('replaces an existing block in place when content drifts', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'persona-update-'));
    try {
      const filePath = path.join(tmp, 'CLAUDE.md');
      await installPersona({
        targets: [fileTarget(filePath)],
        personaContent: FIXED_PERSONA,
        version: '0.8.0',
      });
      const updated = `${FIXED_PERSONA}\n\n- Added rule: always supersede on changes of mind.`;
      const results = await installPersona({
        targets: [fileTarget(filePath)],
        personaContent: updated,
        version: '0.9.0',
      });
      const outcome = results[0]?.outcome;
      expect(outcome?.kind).toBe('updated');
      if (outcome?.kind === 'updated') {
        expect(outcome.previousVersion).toBe('0.8.0');
      }
      const content = readFileSync(filePath, 'utf8');
      // New block is present.
      expect(content).toContain('<!-- memento:persona BEGIN v0.9.0 -->');
      expect(content).toContain('always supersede');
      // Old block does not coexist — splice replaced it.
      expect(content).not.toContain('BEGIN v0.8.0');
      // No accumulated blank-line growth across re-installs.
      expect(content).not.toMatch(/\n\n\n\n/u);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes through UI-only targets as `ui-only` outcomes', async () => {
    const target: PersonaTarget = {
      kind: 'ui',
      clientId: 'claude-chat',
      displayName: 'Claude (web)',
      uiPath: 'claude.ai → Settings → Profile → Custom Instructions',
    };
    const results = await installPersona({
      targets: [target],
      personaContent: FIXED_PERSONA,
      version: FIXED_VERSION,
    });
    expect(results.length).toBe(1);
    const outcome = results[0]?.outcome;
    expect(outcome?.kind).toBe('ui-only');
    if (outcome?.kind === 'ui-only') {
      expect(outcome.uiPath).toMatch(/claude\.ai/i);
    }
  });
});

describe('uninstallPersona', () => {
  function fileTarget(filePath: string): PersonaTarget {
    return {
      kind: 'file',
      clientId: 'claude-code',
      displayName: 'Claude Code',
      path: filePath,
    };
  }

  it('strips the marker block and leaves user content intact', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'persona-uninst-'));
    try {
      const filePath = path.join(tmp, 'CLAUDE.md');
      const existing = '# Personal preferences\n\n- I prefer pnpm over npm.\n';
      writeFileSync(filePath, existing);
      await installPersona({
        targets: [fileTarget(filePath)],
        personaContent: FIXED_PERSONA,
        version: FIXED_VERSION,
      });
      const results = await uninstallPersona({ targets: [fileTarget(filePath)] });
      expect(results[0]?.outcome.kind).toBe('updated');
      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('I prefer pnpm over npm.');
      expect(content).not.toContain('memento:persona');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('no-ops when the file has no marker block', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'persona-uninst-noop-'));
    try {
      const filePath = path.join(tmp, 'CLAUDE.md');
      writeFileSync(filePath, '# Just user content. Memento never touched this.\n');
      const before = readFileSync(filePath, 'utf8');
      const results = await uninstallPersona({ targets: [fileTarget(filePath)] });
      expect(results[0]?.outcome.kind).toBe('already-current');
      const after = readFileSync(filePath, 'utf8');
      expect(after).toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
