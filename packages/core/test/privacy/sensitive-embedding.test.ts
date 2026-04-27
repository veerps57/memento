// Privacy / `sensitive` flag — embedding-side behaviour contract.
//
// See `docs/architecture/privacy.md`. The point of this file is
// to lock down (in tests) the design choice that
// `sensitive = true` is a projection control, not a storage or
// indexing control. Specifically: sensitive memories ARE embedded
// on equal terms with non-sensitive memories, and they ARE
// candidates for vector / FTS retrieval. Redaction happens later
// at the `memory.list` / `memory.search` projection layer (covered
// elsewhere).
//
// If a future refactor wants to *change* this contract — e.g.
// "skip sensitive rows during embedding" — that is a behaviour
// change that needs an ADR amendment, and these tests will be the
// canary.

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

function baseInput(content: string, sensitive: boolean): MemoryWriteInput {
  return {
    scope: { type: 'global' },
    owner: { type: 'local', id: 'tester' },
    kind: { type: 'fact' },
    tags: [],
    pinned: false,
    content,
    summary: null,
    storedConfidence: 0.9,
    sensitive,
  };
}

function fakeProvider(model: string, dimension: number) {
  const calls: string[] = [];
  const provider: EmbeddingProvider = {
    model,
    dimension,
    embed: async (text: string) => {
      calls.push(text);
      const v: number[] = [];
      for (let i = 0; i < dimension; i += 1) v.push((text.length + i) / dimension);
      return v;
    },
  };
  return { provider, calls };
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

describe('privacy: sensitive flag does not change embedding-side behaviour', () => {
  it('reembedAll embeds sensitive memories on equal terms with non-sensitive ones', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);

    const a = await repo.write(baseInput('public note alpha', false), { actor });
    const b = await repo.write(baseInput('SECRET note bravo', true), { actor });

    const { provider, calls } = fakeProvider('test-model', 4);
    const result = await reembedAll(repo, provider, { actor });

    // Both rows scanned, both embedded — sensitive is not a filter.
    expect(result.scanned).toBe(2);
    expect(result.embedded).toHaveLength(2);
    expect(result.embedded).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(result.skipped).toEqual([]);

    // The embedding provider was called with the sensitive row's
    // raw content (we are NOT scrubbing, masking, or substituting).
    expect(calls).toEqual(expect.arrayContaining(['public note alpha', 'SECRET note bravo']));

    // The vector is persisted on the sensitive row.
    const stored = await repo.read(b.id);
    expect(stored?.embedding).not.toBeNull();
    expect(stored?.embedding?.model).toBe('test-model');
    expect(stored?.embedding?.dimension).toBe(4);
    expect(stored?.embedding?.vector).toHaveLength(4);
  });

  it('repo.list returns sensitive rows (filtering is a projection concern, not a storage one)', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);

    await repo.write(baseInput('public', false), { actor });
    await repo.write(baseInput('SECRET', true), { actor });

    const all = await repo.list({ status: 'active' });
    expect(all).toHaveLength(2);
    // Sensitive row carries its content unredacted at the repo
    // boundary — redaction is the command-layer projection.
    const sensitive = all.find((m) => m.sensitive === true);
    expect(sensitive).toBeDefined();
    expect(sensitive?.content).toBe('SECRET');
  });

  it('memory.set_embedding stores a vector on a sensitive memory without complaint', async () => {
    const handle = await fixture();
    const repo = await makeRepo(handle);

    const m = await repo.write(baseInput('SECRET payload', true), { actor });

    await repo.setEmbedding(
      m.id,
      { model: 'manual-model', dimension: 3, vector: [0.1, 0.2, 0.3] },
      { actor },
    );

    const after = await repo.read(m.id);
    expect(after?.sensitive).toBe(true);
    expect(after?.embedding?.model).toBe('manual-model');
    expect(after?.embedding?.vector).toEqual([0.1, 0.2, 0.3]);
  });
});
