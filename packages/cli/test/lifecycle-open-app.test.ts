// `openAppForSurface` — branch coverage for the embedder
// auto-wire path. Three cases mirror the documented behaviour:
//
//   1. `retrieval.vector.enabled=false` (the default for a
//      fresh in-memory db) — the helper opens once, never
//      touches the embedder, and the registry has no
//      `embedding.rebuild` command.
//   2. flag is true and `resolveEmbedder` returns a provider —
//      the helper closes the probe, reopens, and the registry
//      gains `embedding.rebuild`.
//   3. flag is true and `resolveEmbedder` returns `undefined`
//      (peer dep missing) — the helper returns CONFIG_ERROR
//      with an install hint pointing at @psraghuveer/memento-embedder-local.

import {
  type AnyCommand,
  type EmbeddingProvider,
  createMementoApp,
} from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import { openAppForSurface } from '../src/lifecycle/open-app.js';
import type { LifecycleDeps } from '../src/lifecycle/types.js';

const rejectMigrateStore: LifecycleDeps['migrateStore'] = async () => {
  throw new Error('migrateStore should not be called');
};
const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called');
};

const fakeProvider: EmbeddingProvider = {
  model: 'fake-model',
  dimension: 4,
  async embed() {
    return [0, 0, 0, 0];
  },
};

describe('openAppForSurface', () => {
  it('opens once and skips the embedder when retrieval.vector.enabled is false', async () => {
    let openCount = 0;
    let resolveCount = 0;
    const deps: LifecycleDeps = {
      createApp: async (opts) => {
        openCount += 1;
        return createMementoApp({
          ...opts,
          configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
        });
      },
      migrateStore: rejectMigrateStore,
      serveStdio: rejectServeStdio,
      resolveEmbedder: async () => {
        resolveCount += 1;
        return undefined;
      },
    };
    const result = await openAppForSurface(deps, { dbPath: ':memory:' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(openCount).toBe(1);
      expect(resolveCount).toBe(0);
      // No embedder wired → embedding.rebuild absent from registry.
      const names = result.value.registry.list().map((c: AnyCommand) => c.name);
      expect(names).not.toContain('embedding.rebuild');
    } finally {
      result.value.close();
    }
  });

  it('reopens with the embedder when the flag is true and the resolver returns a provider', async () => {
    let openCount = 0;
    const deps: LifecycleDeps = {
      createApp: async (opts) => {
        openCount += 1;
        return createMementoApp(opts);
      },
      migrateStore: rejectMigrateStore,
      serveStdio: rejectServeStdio,
      resolveEmbedder: async () => fakeProvider,
    };

    // Flip the flag inside a throwaway app, then call the helper.
    const seed = await createMementoApp({ dbPath: ':memory:' });
    // We can't share :memory: across opens, so seed an on-disk db.
    seed.close();

    // Use a real on-disk path so config persists across the
    // helper's two opens. tmpdir + a file we delete after.
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'memento-openapp-'));
    const dbPath = join(dir, 'memento.db');
    try {
      const seeded = await createMementoApp({ dbPath });
      try {
        await seeded.configRepository.set(
          { key: 'retrieval.vector.enabled', value: true, source: 'cli' },
          { actor: { type: 'cli' } },
        );
      } finally {
        seeded.close();
      }

      const result = await openAppForSurface(deps, { dbPath });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      try {
        // probe + reopen → 2 createApp calls.
        expect(openCount).toBe(2);
        const names = result.value.registry.list().map((c: AnyCommand) => c.name);
        expect(names).toContain('embedding.rebuild');
      } finally {
        result.value.close();
      }
    } finally {
      const { rmTmpSync } = await import('./_helpers/rm-tmp.js');
      rmTmpSync(dir);
    }
  });

  it('returns CONFIG_ERROR when the flag is true but the resolver returns undefined', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'memento-openapp-'));
    const dbPath = join(dir, 'memento.db');
    try {
      const seeded = await createMementoApp({ dbPath });
      try {
        await seeded.configRepository.set(
          { key: 'retrieval.vector.enabled', value: true, source: 'cli' },
          { actor: { type: 'cli' } },
        );
      } finally {
        seeded.close();
      }

      const deps: LifecycleDeps = {
        createApp: createMementoApp,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        resolveEmbedder: async () => undefined,
      };
      const result = await openAppForSurface(deps, { dbPath });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONFIG_ERROR');
      expect(result.error.message).toContain('@psraghuveer/memento-embedder-local');
      expect(result.error.message).toContain('could not be resolved');
    } finally {
      const { rmTmpSync } = await import('./_helpers/rm-tmp.js');
      rmTmpSync(dir);
    }
  });

  it('maps createApp failures on the first open to STORAGE_ERROR', async () => {
    const deps: LifecycleDeps = {
      createApp: async () => {
        throw new Error('disk on fire');
      },
      migrateStore: rejectMigrateStore,
      serveStdio: rejectServeStdio,
    };
    const result = await openAppForSurface(deps, { dbPath: '/no/such/path.db' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.message).toContain('/no/such/path.db');
    expect(result.error.message).toContain('disk on fire');
  });

  it('returns CONFIG_ERROR when vector is enabled but no resolver is supplied', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'memento-openapp-'));
    const dbPath = join(dir, 'memento.db');
    try {
      const seeded = await createMementoApp({ dbPath });
      try {
        await seeded.configRepository.set(
          { key: 'retrieval.vector.enabled', value: true, source: 'cli' },
          { actor: { type: 'cli' } },
        );
      } finally {
        seeded.close();
      }

      // No resolveEmbedder at all.
      const deps: LifecycleDeps = {
        createApp: createMementoApp,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
      };
      const result = await openAppForSurface(deps, { dbPath });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONFIG_ERROR');
      expect(result.error.message).toContain('no embedder resolver');
    } finally {
      const { rmTmpSync } = await import('./_helpers/rm-tmp.js');
      rmTmpSync(dir);
    }
  });

  it('returns CONFIG_ERROR when the embedder resolver throws', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'memento-openapp-'));
    const dbPath = join(dir, 'memento.db');
    try {
      const seeded = await createMementoApp({ dbPath });
      try {
        await seeded.configRepository.set(
          { key: 'retrieval.vector.enabled', value: true, source: 'cli' },
          { actor: { type: 'cli' } },
        );
      } finally {
        seeded.close();
      }

      const deps: LifecycleDeps = {
        createApp: createMementoApp,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        resolveEmbedder: async () => {
          throw new Error('dlopen failed');
        },
      };
      const result = await openAppForSurface(deps, { dbPath });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONFIG_ERROR');
      expect(result.error.message).toContain('failed to load');
      expect(result.error.message).toContain('dlopen failed');
    } finally {
      const { rmTmpSync } = await import('./_helpers/rm-tmp.js');
      rmTmpSync(dir);
    }
  });

  it('includes ABI rebuild hint when createApp fails with NODE_MODULE_VERSION', async () => {
    const deps: LifecycleDeps = {
      createApp: async () => {
        throw new Error('ERR_DLOPEN_FAILED: was compiled against a different Node.js version');
      },
      migrateStore: rejectMigrateStore,
      serveStdio: rejectServeStdio,
    };
    const result = await openAppForSurface(deps, { dbPath: '/tmp/test.db' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.hint).toContain('npm rebuild');
  });

  it('includes ENOENT hint when createApp fails with missing path', async () => {
    const deps: LifecycleDeps = {
      createApp: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
      migrateStore: rejectMigrateStore,
      serveStdio: rejectServeStdio,
    };
    const result = await openAppForSurface(deps, { dbPath: '/no/such/dir/test.db' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.hint).toContain('mkdir');
  });

  it('includes permission hint when createApp fails with EACCES', async () => {
    const deps: LifecycleDeps = {
      createApp: async () => {
        throw new Error('EACCES: permission denied');
      },
      migrateStore: rejectMigrateStore,
      serveStdio: rejectServeStdio,
    };
    const result = await openAppForSurface(deps, { dbPath: '/tmp/test.db' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.hint).toContain('permission');
  });

  it('includes SQLITE_NOTADB hint when the path is not a database', async () => {
    const deps: LifecycleDeps = {
      createApp: async () => {
        throw new Error('SQLITE_NOTADB: file is not a database');
      },
      migrateStore: rejectMigrateStore,
      serveStdio: rejectServeStdio,
    };
    const result = await openAppForSurface(deps, { dbPath: '/tmp/test.db' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.hint).toContain('not a SQLite database');
  });
});
