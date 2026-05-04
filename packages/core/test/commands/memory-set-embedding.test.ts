// Tests for the `memory.set_embedding` command's CONFIG_ERROR guard
// against caller-supplied vectors that mismatch the configured
// embedder. The repository layer accepts any (vector, dimension)
// where lengths agree; this command-layer guard keeps the vector
// store consistent with the search-time invariant.

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand } from '../../src/commands/execute.js';
import { createMemoryCommands } from '../../src/commands/memory/commands.js';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

const actor: ActorRef = { type: 'cli' };
const ctx = { actor };

interface OpenHandle {
  close(): void;
}
const handles: OpenHandle[] = [];
afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    return `${prefix}${String(i).padStart(26 - prefix.length, '0')}`;
  };
}

async function fixture(opts: { configuredEmbedder?: { model: string; dimension: number } } = {}) {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  const repo = createMemoryRepository(handle.db, {
    clock: () => '2026-01-01T00:00:00.000Z' as never,
    memoryIdFactory: counterFactory('M') as never,
    eventIdFactory: counterFactory('E'),
  });
  const commands = createMemoryCommands(
    repo,
    undefined,
    opts.configuredEmbedder !== undefined ? { configuredEmbedder: opts.configuredEmbedder } : {},
  );
  const setEmbedding = commands.find((c) => c.name === 'memory.set_embedding');
  if (setEmbedding === undefined) throw new Error('memory.set_embedding not registered');
  const memory = await repo.write(
    {
      scope: { type: 'global' },
      owner: { type: 'local', id: 'self' },
      kind: { type: 'fact' },
      tags: [],
      pinned: false,
      content: 'embedding mismatch probe',
      summary: null,
      storedConfidence: 1,
    },
    { actor },
  );
  return { repo, setEmbedding, memoryId: memory.id };
}

describe('memory.set_embedding configured-embedder guard', () => {
  it('rejects a dimension that disagrees with the configured embedder', async () => {
    const { setEmbedding, memoryId } = await fixture({
      configuredEmbedder: { model: 'bge-base-en-v1.5', dimension: 768 },
    });
    const result = await executeCommand(
      setEmbedding,
      { id: memoryId, model: 'bge-base-en-v1.5', dimension: 3, vector: [1, 2, 3] },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG_ERROR');
    expect(result.error.message).toMatch(/dimension/iu);
    expect(result.error.message).toMatch(/embedding rebuild/u);
  });

  it('rejects a model that disagrees with the configured embedder', async () => {
    const { setEmbedding, memoryId } = await fixture({
      configuredEmbedder: { model: 'bge-base-en-v1.5', dimension: 768 },
    });
    const result = await executeCommand(
      setEmbedding,
      {
        id: memoryId,
        model: 'totally-fake-model',
        dimension: 768,
        vector: Array.from({ length: 768 }, (_v, i) => i / 768),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG_ERROR');
    expect(result.error.message).toMatch(/model/iu);
  });

  it('accepts a vector whose model + dimension match the configured embedder', async () => {
    const { setEmbedding, memoryId } = await fixture({
      configuredEmbedder: { model: 'bge-base-en-v1.5', dimension: 4 },
    });
    const result = await executeCommand(
      setEmbedding,
      { id: memoryId, model: 'bge-base-en-v1.5', dimension: 4, vector: [0.1, 0.2, 0.3, 0.4] },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts any well-formed vector when no embedder is configured (backwards compat)', async () => {
    // Hosts that don't wire an embedder keep the legacy "set raw
    // vector for testing" affordance — useful for offline test
    // fixtures that pre-seed embeddings without running the model.
    const { setEmbedding, memoryId } = await fixture(); // no configuredEmbedder
    const result = await executeCommand(
      setEmbedding,
      { id: memoryId, model: 'fake', dimension: 3, vector: [0.1, 0.2, 0.3] },
      ctx,
    );
    expect(result.ok).toBe(true);
  });
});
