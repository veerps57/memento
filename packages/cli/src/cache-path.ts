// Default cache-dir resolution for the local embedder model.
//
// `transformers.js` defaults its cache directory to a path
// inside `node_modules/@huggingface/transformers/.cache/`. That
// is a hostile location:
//
//   - It is wiped on `pnpm install` / `npm ci`, so every fresh
//     install re-downloads the model (`bge-base-en-v1.5`,
//     ~110 MB).
//   - Permissions are inherited from the package install (often
//     world-readable on shared hosts).
//   - A colluding dep with write access to `node_modules` could
//     plant a hostile ONNX file there; the embedder would load
//     it on next startup.
//
// We resolve to a per-user, persistent cache directory instead:
//
//   $XDG_CACHE_HOME/memento/models             if set
//   ~/.cache/memento/models                    on Linux/macOS
//   %LOCALAPPDATA%\memento\Cache\models        on Windows
//
// The lifecycle layer creates the directory with mode 0o700 on
// the first use (data-private; embedder cache files are not
// secret but they live next to the operator's DB and we keep
// the perms consistent).
//
// `embedder.local.cacheDir` (a ConfigKey) overrides this when
// set to a non-null string; the resolver only fires for the
// `null` default.

import os from 'node:os';
import path from 'node:path';

export interface ResolveDefaultCacheDirOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir?: () => string;
  readonly platform?: NodeJS.Platform;
}

/**
 * Compute the default embedder model cache directory for this
 * host. Pure: no IO, no mkdir.
 */
export function resolveDefaultCacheDir(options: ResolveDefaultCacheDirOptions): string {
  const { env } = options;
  const homedir = options.homedir ?? os.homedir;
  const platform = options.platform ?? process.platform;

  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg !== undefined && xdg.length > 0) {
    return path.join(xdg, 'memento', 'models');
  }

  if (platform === 'win32') {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.length > 0) {
      return path.join(localAppData, 'memento', 'Cache', 'models');
    }
    const home = safeHomedir(homedir);
    if (home !== undefined) {
      return path.join(home, 'AppData', 'Local', 'memento', 'Cache', 'models');
    }
    return path.join('.', '.memento-cache', 'models');
  }

  // Linux, macOS, BSDs.
  const home = safeHomedir(homedir);
  if (home !== undefined) {
    return path.join(home, '.cache', 'memento', 'models');
  }
  return path.join('.', '.memento-cache', 'models');
}

function safeHomedir(homedir: () => string): string | undefined {
  try {
    const value = homedir();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
