import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../src/embedding/provider.js';
import { reembedAll } from '../../src/embedding/reembed.js';
import {
  type MemoryWriteInput,
  createMemoryRepository,
} from '../../src/repository/memory-repository.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

interface OpenHandle {
  close(): void;
}
const handles: OpenHandle[] = [];
afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
});

async function fixture() {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  return handle;
}

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    const num = String(i).padStart(26 - prefix.length, '0');
    return `${prefix}${num}`;
  };
}

const actor: ActorRef = { type: 'cli' };

function baseInput(content: string): MemoryWriteInput {
  return {
    scope: { type: 'global' },
    owner: { type: 'local', id: 'tester' },
    kind: { type: 'fact' },
    tags: [],
    pinned: false,
    content,
    summary: null,
    storedConfidence: 0.9,
  };
}

interface FakeProvider extends EmbeddingProvider {
  readonly calls: string[];
}

function fakeProvider(model: string, dimension: number): FakeProvider {
  const calls: string[] = [];
  return {
    model,
    dimension,
    calls,
    embed: async (text: string) => {
      calls.push(text);
      const v: number[] = [];
      for (let i = 0; i < dimension; i += 1) {
        v.push((text.length + i) / dimension);
      }
      return v;
    },
  };
}

async function makeRepo(handle: Awaited<ReturnType<typeof fixture>>) {
  let now = new Date(2025, 0, 1).getTime();
  return createMemoryRepository(handle.db, {
    clock: () => {
      now += 1000;
      return new Date(now).toISOString() as never;
    },
    memoryIdFactory: counterFactory('M') as never,
    eventIdFactory: counterFactory('E'),
  });
}

describe('reembedAll', () => {
  it('embeds active memories that have no embedding', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const a = await repo.write(baseInput('alpha'), { actor });
    const b = await repo.write(baseInput('beta'), { actor });
    const provider = fakeProvider('bge-small-en-v1.5', 4);

    const result = await reembedAll(repo, provider, { actor });

    expect(result.scanned).toBe(2);
    expect(new Set(result.embedded)).toEqual(new Set([a.id, b.id]));
    expect(result.skipped).toEqual([]);
    expect(provider.calls.sort()).toEqual(['alpha', 'beta']);

    const fresh = await repo.read(a.id);
    expect(fresh?.embedding?.model).toBe('bge-small-en-v1.5');
    expect(fresh?.embedding?.dimension).toBe(4);
  });

  it('skips memories whose embedding already matches the provider model + dimension', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const m = await repo.write(baseInput('alpha'), { actor });
    const provider = fakeProvider('bge-small-en-v1.5', 4);
    await repo.setEmbedding(
      m.id,
      {
        model: provider.model,
        dimension: provider.dimension,
        vector: [1, 2, 3, 4],
      },
      { actor },
    );
    provider.calls.length = 0;

    const result = await reembedAll(repo, provider, { actor });

    expect(result.embedded).toEqual([]);
    expect(result.skipped).toEqual([{ id: m.id, reason: 'up-to-date' }]);
    expect(provider.calls).toEqual([]);
  });

  it('reembeds when the model differs', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const m = await repo.write(baseInput('alpha'), { actor });
    await repo.setEmbedding(
      m.id,
      { model: 'old-model', dimension: 4, vector: [1, 2, 3, 4] },
      { actor },
    );
    const provider = fakeProvider('bge-small-en-v1.5', 4);

    const result = await reembedAll(repo, provider, { actor });
    expect(result.embedded).toEqual([m.id]);
    const fresh = await repo.read(m.id);
    expect(fresh?.embedding?.model).toBe('bge-small-en-v1.5');
  });

  it('reembeds when the dimension differs', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const m = await repo.write(baseInput('alpha'), { actor });
    await repo.setEmbedding(
      m.id,
      { model: 'bge-small-en-v1.5', dimension: 2, vector: [1, 2] },
      { actor },
    );
    const provider = fakeProvider('bge-small-en-v1.5', 4);

    const result = await reembedAll(repo, provider, { actor });
    expect(result.embedded).toEqual([m.id]);
    const fresh = await repo.read(m.id);
    expect(fresh?.embedding?.dimension).toBe(4);
  });

  it('honours `force` and reembeds even fresh rows', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const m = await repo.write(baseInput('alpha'), { actor });
    const provider = fakeProvider('bge-small-en-v1.5', 4);
    await repo.setEmbedding(
      m.id,
      {
        model: provider.model,
        dimension: provider.dimension,
        vector: [1, 2, 3, 4],
      },
      { actor },
    );
    provider.calls.length = 0;

    const result = await reembedAll(repo, provider, { actor, force: true });
    expect(result.embedded).toEqual([m.id]);
    expect(provider.calls).toEqual(['alpha']);
  });

  it('skips non-active memories by default (active-only list filter)', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const a = await repo.write(baseInput('alpha'), { actor });
    const b = await repo.write(baseInput('beta'), { actor });
    await repo.forget(b.id, null, { actor });

    const provider = fakeProvider('bge-small-en-v1.5', 4);
    const result = await reembedAll(repo, provider, { actor });
    expect(result.scanned).toBe(1);
    expect(result.embedded).toEqual([a.id]);
  });

  it('widens the scan to forgotten / archived under `includeNonActive`', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const a = await repo.write(baseInput('alpha'), { actor });
    const b = await repo.write(baseInput('beta'), { actor });
    const c = await repo.write(baseInput('gamma'), { actor });
    await repo.forget(b.id, null, { actor });
    await repo.archive(c.id, { actor });

    const provider = fakeProvider('bge-small-en-v1.5', 4);
    const result = await reembedAll(repo, provider, {
      actor,
      includeNonActive: true,
    });
    expect(result.scanned).toBe(3);
    expect([...result.embedded].sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('records `error` skips when the provider throws and continues with the rest', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const a = await repo.write(baseInput('boom'), { actor });
    const b = await repo.write(baseInput('beta'), { actor });
    const provider: EmbeddingProvider = {
      model: 'bge-small-en-v1.5',
      dimension: 4,
      embed: async (text) => {
        if (text === 'boom') throw new Error('forced failure');
        return [0.1, 0.2, 0.3, 0.4];
      },
    };

    const result = await reembedAll(repo, provider, { actor });
    expect(result.embedded).toEqual([b.id]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.id).toBe(a.id);
    expect(result.skipped[0]!.reason).toBe('error');
    expect(result.skipped[0]!.error).toBeInstanceOf(Error);
  });

  it('rejects non-positive batchSize', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const provider = fakeProvider('m', 4);
    await expect(reembedAll(repo, provider, { actor, batchSize: 0 })).rejects.toThrow(RangeError);
    await expect(reembedAll(repo, provider, { actor, batchSize: -1 })).rejects.toThrow(RangeError);
  });

  it('uses batch embed path — embed is not called individually per memory', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    await repo.write(baseInput('alpha'), { actor });
    await repo.write(baseInput('beta'), { actor });
    await repo.write(baseInput('gamma'), { actor });

    let individualEmbedCalls = 0;
    let batchCalls = 0;
    const provider: EmbeddingProvider = {
      model: 'bge-small-en-v1.5',
      dimension: 4,
      embed: async (_text: string) => {
        individualEmbedCalls += 1;
        return [0.1, 0.2, 0.3, 0.4];
      },
      embedBatch: async (texts: readonly string[]) => {
        batchCalls += 1;
        return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
      },
    };

    const result = await reembedAll(repo, provider, { actor });

    expect(result.embedded).toHaveLength(3);
    expect(batchCalls).toBe(1);
    expect(individualEmbedCalls).toBe(0);
  });

  it('marks all stale memories as error skips when both batch and per-row embed fail', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const a = await repo.write(baseInput('alpha'), { actor });
    const b = await repo.write(baseInput('beta'), { actor });

    const provider: EmbeddingProvider = {
      model: 'bge-small-en-v1.5',
      dimension: 4,
      embed: async (_text: string) => {
        throw new Error('embed unavailable');
      },
      embedBatch: async (_texts: readonly string[]) => {
        throw new Error('OOM: batch embed failed');
      },
    };

    const result = await reembedAll(repo, provider, { actor });

    // Batch fails → per-row fallback also fails → all are error skips.
    expect(result.embedded).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    const skippedIds = new Set(result.skipped.map((s) => s.id));
    expect(skippedIds).toContain(a.id);
    expect(skippedIds).toContain(b.id);
    for (const skip of result.skipped) {
      expect(skip.reason).toBe('error');
      expect(skip.error).toBeInstanceOf(Error);
    }
  });

  it('falls back to per-row embed when batch fails, isolating individual errors', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);
    const a = await repo.write(baseInput('boom'), { actor });
    const b = await repo.write(baseInput('beta'), { actor });
    const c = await repo.write(baseInput('gamma'), { actor });

    let batchAttempted = false;
    const provider: EmbeddingProvider = {
      model: 'bge-small-en-v1.5',
      dimension: 4,
      embed: async (text: string) => {
        if (text === 'boom') throw new Error('bad content');
        return [0.1, 0.2, 0.3, 0.4];
      },
      embedBatch: async (_texts: readonly string[]) => {
        batchAttempted = true;
        throw new Error('batch unavailable');
      },
    };

    const result = await reembedAll(repo, provider, { actor });

    // Batch was attempted first, then per-row fallback kicked in.
    expect(batchAttempted).toBe(true);
    // 'boom' failed per-row; 'beta' and 'gamma' succeeded.
    expect(result.embedded).toHaveLength(2);
    expect(result.embedded).toContain(b.id);
    expect(result.embedded).toContain(c.id);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.id).toBe(a.id);
    expect(result.skipped[0]!.reason).toBe('error');
  });
});
