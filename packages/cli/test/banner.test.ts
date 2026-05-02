import { describe, expect, it } from 'vitest';

import { renderBanner, shouldUseColor } from '../src/banner.js';

describe('shouldUseColor', () => {
  it('honours NO_COLOR over a TTY', () => {
    expect(shouldUseColor({ NO_COLOR: '1' }, true)).toBe(false);
  });

  it('treats empty NO_COLOR as unset', () => {
    expect(shouldUseColor({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('FORCE_COLOR overrides a non-TTY', () => {
    expect(shouldUseColor({ FORCE_COLOR: '1' }, false)).toBe(true);
  });

  it('FORCE_COLOR=0 is treated as unset', () => {
    expect(shouldUseColor({ FORCE_COLOR: '0' }, false)).toBe(false);
  });

  it('NO_COLOR wins over FORCE_COLOR', () => {
    expect(shouldUseColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('falls back to TTY hint when neither var is set', () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
  });
});

describe('renderBanner', () => {
  it('embeds the version in the subtitle', () => {
    const out = renderBanner('0.1.0', { color: false });
    expect(out).toContain('v0.1.0');
    expect(out).toContain('Persistent memory for AI assistants');
  });

  it('emits no ANSI escapes when color is false', () => {
    const out = renderBanner('0.1.0', { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: test asserts absence of ANSI escapes
    expect(out).not.toMatch(/\u001b\[/);
  });

  it('wraps the figlet in ANSI escapes when color is true', () => {
    const out = renderBanner('0.1.0', { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: test asserts presence of ANSI escapes
    expect(out).toMatch(/\u001b\[38;2;232;184;108m/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: test asserts presence of ANSI reset
    expect(out).toMatch(/\u001b\[0m/);
  });

  it('ends with a single trailing newline', () => {
    const out = renderBanner('0.1.0', { color: false });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n\n')).toBe(false);
  });
});
