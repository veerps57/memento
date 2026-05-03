// Default cache-dir resolution for the local embedder model.
//
// The resolver is pure (no IO); these tests exercise the
// platform / env permutations without touching the real
// filesystem.

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDefaultCacheDir } from '../src/cache-path.js';

describe('resolveDefaultCacheDir', () => {
  it('honours XDG_CACHE_HOME when set', () => {
    const result = resolveDefaultCacheDir({
      env: { XDG_CACHE_HOME: '/custom/xdg' },
      homedir: () => '/home/alice',
      platform: 'linux',
    });
    expect(result).toBe(path.join('/custom/xdg', 'memento', 'models'));
  });

  it('falls back to ~/.cache on Linux when XDG_CACHE_HOME is unset', () => {
    const result = resolveDefaultCacheDir({
      env: {},
      homedir: () => '/home/alice',
      platform: 'linux',
    });
    expect(result).toBe(path.join('/home/alice', '.cache', 'memento', 'models'));
  });

  it('falls back to ~/.cache on macOS when XDG_CACHE_HOME is unset', () => {
    const result = resolveDefaultCacheDir({
      env: {},
      homedir: () => '/Users/alice',
      platform: 'darwin',
    });
    expect(result).toBe(path.join('/Users/alice', '.cache', 'memento', 'models'));
  });

  it('uses LOCALAPPDATA on Windows when set', () => {
    const result = resolveDefaultCacheDir({
      env: { LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
      homedir: () => 'C:\\Users\\Alice',
      platform: 'win32',
    });
    expect(result).toBe(
      path.join('C:\\Users\\Alice\\AppData\\Local', 'memento', 'Cache', 'models'),
    );
  });

  it('falls back to a homedir-relative path on Windows without LOCALAPPDATA', () => {
    const result = resolveDefaultCacheDir({
      env: {},
      homedir: () => 'C:\\Users\\Alice',
      platform: 'win32',
    });
    expect(result).toContain('memento');
    expect(result).toContain('Cache');
    expect(result).toContain('models');
  });

  it('XDG_CACHE_HOME wins over LOCALAPPDATA on Windows', () => {
    const result = resolveDefaultCacheDir({
      env: {
        XDG_CACHE_HOME: 'D:\\xdg-cache',
        LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
      },
      homedir: () => 'C:\\Users\\Alice',
      platform: 'win32',
    });
    expect(result).toBe(path.join('D:\\xdg-cache', 'memento', 'models'));
  });

  it('does not place the cache under node_modules', () => {
    // Regression guard: the whole point of this resolver is to
    // move the cache off `node_modules/.../@huggingface/transformers/.cache/`
    // where reinstalls wipe it and a colluding dep could plant a
    // hostile model file.
    const linux = resolveDefaultCacheDir({
      env: {},
      homedir: () => '/home/alice',
      platform: 'linux',
    });
    expect(linux).not.toContain('node_modules');
    const win = resolveDefaultCacheDir({
      env: { LOCALAPPDATA: 'C:\\AppData' },
      homedir: () => 'C:\\Users\\Alice',
      platform: 'win32',
    });
    expect(win).not.toContain('node_modules');
  });
});
