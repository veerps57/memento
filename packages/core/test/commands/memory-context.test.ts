// Tests for `memory.context` — query-less ranked retrieval.

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand } from '../../src/commands/execute.js';
import { createMemoryContextCommand } from '../../src/commands/memory/context.js';
import { createConfigStore } from '../../src/config/index.js';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

function counterFactory(prefix: string): () => string {
  let i = 0;
  return () => {
    i += 1;
    return `${prefix}${String(i).padStart(24, '0')}`;
  };
}

const actor: ActorRef = { type: 'cli' };
const ctx = { actor };
const fixedClock = '2025-06-01T12:00:00.000Z';

interface OpenHandle {
  close(): void;
  db: Parameters<typeof migrateToLatest>[0];
}
const handles: OpenHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.close();
});

async function fixture(configOverrides: Record<string, unknown> = {}) {
  const handle = openDatabase({ path: ':memory:' });
  handles.push(handle);
  await migrateToLatest(handle.db, MIGRATIONS);
  const repo = createMemoryRepository(handle.db, {
    clock: () => fixedClock as never,
    memoryIdFactory: counterFactory('M0') as never,
    eventIdFactory: counterFactory('E0'),
  });
  const configStore = createConfigStore({
    'retrieval.vector.enabled': false,
    'retrieval.recency.halfLife': 30 * 86_400_000,
    'retrieval.scopeBoost': 0.1,
    'context.defaultLimit': 20,
    'context.maxLimit': 100,
    'context.includeKinds': ['fact', 'preference', 'decision'],
    'context.ranker.weights.confidence': 1.0,
    'context.ranker.weights.recency': 1.5,
    'context.ranker.weights.scope': 2.0,
    'context.ranker.weights.pinned': 3.0,
    'context.ranker.weights.frequency': 0.5,
    'privacy.redactSensitiveSnippets': false,
    ...configOverrides,
  });
  const command = createMemoryContextCommand({
    db: handle.db,
    memoryRepository: repo,
    configStore,
    clock: () => fixedClock,
  });
  return { repo, command, handle };
}

describe('memory.context', () => {
  it('returns empty results when store is empty', async () => {
    const { command } = await fixture();
    const result = await executeCommand(command, {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toEqual([]);
    expect(result.value.resolvedKinds).toEqual(['fact', 'preference', 'decision']);
    // Persona-3 follow-up: a fresh AI session calling
    // get_memory_context on an empty store would otherwise see only
    // an empty array and might never start writing. The hint
    // explicitly tells it the store is empty + what to do next.
    expect(result.value.hint).toMatch(/store is empty/i);
    expect(result.value.hint).toMatch(/write_memory|extract_memory/);
  });

  it('returns active memories ranked by score', async () => {
    const { repo, command } = await fixture();

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'User prefers dark mode',
        summary: null,
        storedConfidence: 0.9,
      },
      { actor },
    );
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'preference' },
        tags: [],
        pinned: true,
        content: 'Always use TypeScript strict mode',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    const result = await executeCommand(command, {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(2);
    // Pinned memory should rank higher due to pinned weight.
    expect(result.value.results[0]!.memory.content).toBe('Always use TypeScript strict mode');
  });

  it('filters by kinds from config', async () => {
    const { repo, command } = await fixture({
      'context.includeKinds': ['fact'],
    });

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'A fact',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'preference' },
        tags: [],
        pinned: false,
        content: 'A preference',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    const result = await executeCommand(command, {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(1);
    expect(result.value.results[0]!.memory.content).toBe('A fact');
  });

  it('respects input kinds override', async () => {
    const { repo, command } = await fixture();

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'todo', due: null },
        tags: [],
        pinned: false,
        content: 'Buy groceries',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'A fact',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    // Default kinds exclude todo — should only get the fact.
    const result = await executeCommand(command, {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(1);
    expect(result.value.results[0]!.memory.content).toBe('A fact');

    // Explicit kinds override — ask for todo only.
    const result2 = await executeCommand(command, { kinds: ['todo'] }, ctx);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.results.length).toBe(1);
    expect(result2.value.results[0]!.memory.content).toBe('Buy groceries');
  });

  it('respects limit', async () => {
    const { repo, command } = await fixture();

    for (let i = 0; i < 5; i++) {
      await repo.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'self' },
          kind: { type: 'fact' },
          tags: [],
          pinned: false,
          content: `Fact ${i}`,
          summary: null,
          storedConfidence: 1.0,
        },
        { actor },
      );
    }

    const result = await executeCommand(command, { limit: 2 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(2);
  });

  it('filters by tags (AND logic)', async () => {
    const { repo, command } = await fixture();

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: ['project:memento', 'area:retrieval'],
        pinned: false,
        content: 'Tagged with both',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: ['project:memento'],
        pinned: false,
        content: 'Tagged with one',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    const result = await executeCommand(
      command,
      { tags: ['project:memento', 'area:retrieval'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(1);
    expect(result.value.results[0]!.memory.content).toBe('Tagged with both');
  });

  it('excludes non-active memories', async () => {
    const { repo, command } = await fixture();

    const m = await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'Will be forgotten',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.forget(m.id, 'test', { actor });

    const result = await executeCommand(command, {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(0);
  });

  it('returns score breakdown with all components', async () => {
    const { repo, command } = await fixture();

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: true,
        content: 'A pinned fact',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    const result = await executeCommand(command, {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const breakdown = result.value.results[0]!.breakdown;
    expect(breakdown).toHaveProperty('confidence');
    expect(breakdown).toHaveProperty('recency');
    expect(breakdown).toHaveProperty('scope');
    expect(breakdown).toHaveProperty('pinned');
    expect(breakdown).toHaveProperty('frequency');
    expect(breakdown.pinned).toBe(1);
    expect(breakdown.confidence).toBeGreaterThan(0);
  });

  it('strips embeddings from output', async () => {
    const { repo, command } = await fixture();

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'Test memory',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    const result = await executeCommand(command, {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results[0]!.memory.embedding).toBeNull();
    // Persona-3 follow-up: with `embedding: null` ambiguous between
    // "stripped for payload size" and "vector retrieval is off", we
    // surface `embeddingStatus` so callers always know which one.
    expect(result.value.results[0]!.memory.embeddingStatus).toBeDefined();
  });

  it('returns all active memories when kinds is empty array', async () => {
    const { repo, command } = await fixture({
      'context.includeKinds': [],
    });

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'A fact',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'todo', due: null },
        tags: [],
        pinned: false,
        content: 'A todo',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    const result = await executeCommand(command, { kinds: [] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Empty kinds = no filter, return all.
    expect(result.value.results.length).toBe(2);
  });

  it('rejects invalid limit values', async () => {
    const { command } = await fixture();

    const result = await executeCommand(command, { limit: -5 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');

    const result2 = await executeCommand(command, { limit: 0 }, ctx);
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.error.code).toBe('INVALID_INPUT');
  });

  it('clamps limit to maxLimit', async () => {
    const { repo, command } = await fixture({ 'context.maxLimit': 1 });

    for (let i = 0; i < 3; i++) {
      await repo.write(
        {
          scope: { type: 'global' },
          owner: { type: 'local', id: 'self' },
          kind: { type: 'fact' },
          tags: [],
          pinned: false,
          content: `Fact ${i}`,
          summary: null,
          storedConfidence: 1.0,
        },
        { actor },
      );
    }

    // Request limit 10 but maxLimit is 1.
    const result = await executeCommand(command, { limit: 10 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(1);
  });

  it('boosts scope-local memories above global', async () => {
    const { repo, command } = await fixture();

    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'Global fact',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.write(
      {
        scope: { type: 'repo', remote: 'github.com/user/project' as never },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'Repo fact',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    // With scopes specified, repo should rank above global.
    const result = await executeCommand(
      command,
      {
        scopes: [{ type: 'repo', remote: 'github.com/user/project' as never }, { type: 'global' }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBe(2);
    // First scope in the list gets the highest boost.
    expect(result.value.results[0]!.memory.content).toBe('Repo fact');
  });
});
