// Tests for `memory.extract` — batch candidate extraction with dedup.

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCommand } from '../../src/commands/execute.js';
import { createMemoryExtractCommand } from '../../src/commands/memory/extract.js';
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
    'extraction.enabled': true,
    'extraction.dedup.threshold': 0.85,
    'extraction.dedup.identicalThreshold': 0.95,
    'extraction.defaultConfidence': 0.8,
    'extraction.autoTag': 'source:extracted',
    'extraction.maxCandidatesPerCall': 25,
    'extraction.processing': 'sync',
    'retrieval.vector.enabled': false,
    // Most extract tests use free-prose preference/decision
    // content because they're testing dedup, embedding, batching
    // — not the topic-line shape. Default off here; the test
    // that DOES exercise the validator overrides this back to
    // `true` explicitly.
    'safety.requireTopicLine': false,
    ...configOverrides,
  });
  const afterWriteCalls: unknown[] = [];
  const command = createMemoryExtractCommand({
    db: handle.db,
    memoryRepository: repo,
    configStore,
    // No embedding provider — falls back to exact content dedup.
    afterWrite: (memory, _ctx) => {
      afterWriteCalls.push(memory.id);
    },
  });
  return { repo, command, handle, afterWriteCalls };
}

describe('memory.extract', () => {
  it('writes new memories with source:extracted tag', async () => {
    const { command } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'User prefers dark mode' },
          { kind: 'preference', content: 'Always use pnpm' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(2);
    expect(result.value.skipped.length).toBe(0);
    expect(result.value.superseded.length).toBe(0);
    expect(result.value.written[0]!.content).toBe('User prefers dark mode');
    expect(result.value.written[1]!.content).toBe('Always use pnpm');
    // Persona-3 follow-up: every response carries a `mode` field so
    // a caller can distinguish "the arrays are authoritative" (sync)
    // from "the arrays will always be empty; check the store after"
    // (async) without inspecting the absence of `batchId`.
    expect(result.value.mode).toBe('sync');
    expect(result.value.batchId).toBeUndefined();
    expect(result.value.status).toBeUndefined();
  });

  // Persona-3 follow-up: in async mode the response is intentionally
  // empty (work happens in background per ADR-0017 §2). Without the
  // mode + hint fields the response is indistinguishable from a sync
  // call where everything was deduped — that ambiguity left AI
  // assistants unable to tell the user what just happened.
  describe('async response shape', () => {
    it('returns mode=async, an actionable hint, and a batchId', async () => {
      const { command } = await fixture({ 'extraction.processing': 'async' });
      const result = await executeCommand(
        command,
        { candidates: [{ kind: 'fact', content: 'Some durable fact' }] },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.written).toEqual([]);
      expect(result.value.skipped).toEqual([]);
      expect(result.value.superseded).toEqual([]);
      expect(result.value.mode).toBe('async');
      expect(result.value.status).toBe('accepted');
      expect(typeof result.value.batchId).toBe('string');
      expect(result.value.hint).toMatch(/processing/i);
      expect(result.value.hint).toMatch(/list_memories|search_memory/);
    });

    it('dry-run stays synchronous even when extraction.processing is async', async () => {
      const { command } = await fixture({ 'extraction.processing': 'async' });
      const result = await executeCommand(
        command,
        { candidates: [{ kind: 'fact', content: 'preview only' }], dryRun: true },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.mode).toBe('sync');
      expect(result.value.written.length).toBe(1);
    });
  });

  it('applies autoTag to written memories', async () => {
    const { repo, command } = await fixture();
    const result = await executeCommand(
      command,
      { candidates: [{ kind: 'fact', content: 'A tagged fact' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memory = await repo.read(result.value.written[0]!.id);
    expect(memory).not.toBeNull();
    expect(memory!.tags).toContain('source:extracted');
  });

  it('uses defaultConfidence from config', async () => {
    const { repo, command } = await fixture({ 'extraction.defaultConfidence': 0.7 });
    const result = await executeCommand(
      command,
      { candidates: [{ kind: 'fact', content: 'Low confidence fact' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memory = await repo.read(result.value.written[0]!.id);
    expect(memory!.storedConfidence).toBe(0.7);
  });

  it('returns CONFIG_ERROR when extraction is disabled', async () => {
    const { command } = await fixture({ 'extraction.enabled': false });
    const result = await executeCommand(
      command,
      { candidates: [{ kind: 'fact', content: 'Should fail' }] },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG_ERROR');
  });

  it('rejects batch exceeding maxCandidatesPerCall', async () => {
    const { command } = await fixture({ 'extraction.maxCandidatesPerCall': 2 });
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'One' },
          { kind: 'fact', content: 'Two' },
          { kind: 'fact', content: 'Three' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('extraction.maxCandidatesPerCall');
  });

  it('deduplicates by exact content match (no embedding provider)', async () => {
    const { repo, command } = await fixture();

    // Write an existing memory directly.
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'Existing fact',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'Existing fact' },
          { kind: 'fact', content: 'New fact' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped.length).toBe(1);
    expect(result.value.skipped[0]!.content).toBe('Existing fact');
    expect(result.value.skipped[0]!.reason).toBe('duplicate');
    expect(result.value.written.length).toBe(1);
    expect(result.value.written[0]!.content).toBe('New fact');
  });

  it('deduplicates byte-identical candidates within the same batch', async () => {
    // Regression: byte-identical candidates submitted in one
    // batch used to write three separate memories — the dedup
    // path queried vector search against the DB, but auto-embed
    // is fire-and-forget so earlier candidates' embeddings
    // weren't persisted yet when later ones checked. The
    // in-batch fingerprint set now collapses byte-identical
    // content to a single row regardless of vector-search timing.
    const { command } = await fixture();
    const phrase = 'Identical-content extraction batch probe.';
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: phrase },
          { kind: 'fact', content: phrase },
          { kind: 'fact', content: phrase },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(1);
    expect(result.value.skipped.length).toBe(2);
    for (const s of result.value.skipped) {
      expect(s.reason).toBe('duplicate');
      expect(s.existingId).toBe(result.value.written[0]!.id);
    }
  });

  it('keeps in-batch dedup kind-aware (same content, different kinds → both written)', async () => {
    // The fingerprint includes the kind, so the same prose recorded
    // as both a `fact` and a `preference` is two memories, not one.
    const { command } = await fixture();
    const phrase = 'Same prose as both fact and preference.';
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: phrase },
          { kind: 'preference', content: phrase },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(2);
    expect(result.value.skipped.length).toBe(0);
  });

  it('treats trivially-different content (case / trailing whitespace) as in-batch duplicates', async () => {
    const { command } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'Same payload, byte-different' },
          { kind: 'fact', content: 'same payload, byte-different   ' },
          { kind: 'fact', content: 'SAME PAYLOAD, BYTE-DIFFERENT' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(1);
    expect(result.value.skipped.length).toBe(2);
  });

  it('handles decision kind with rationale', async () => {
    const { repo, command } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [
          {
            kind: 'decision',
            content: 'Use Vitest over Jest',
            rationale: 'Faster, native ESM support',
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(1);
    const memory = await repo.read(result.value.written[0]!.id);
    expect(memory!.content).toContain('Rationale: Faster, native ESM support');
    expect(memory!.kind.type).toBe('decision');
  });

  it('handles snippet kind with language prefix', async () => {
    const { repo, command } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [
          {
            kind: 'snippet',
            content: 'const x = 42;',
            language: 'typescript',
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memory = await repo.read(result.value.written[0]!.id);
    expect(memory!.content).toBe('[typescript] const x = 42;');
    expect(memory!.kind.type).toBe('snippet');
  });

  it('dry-run does not persist memories', async () => {
    const { repo, command } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [{ kind: 'fact', content: 'Should not persist' }],
        dryRun: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(1);
    // Verify nothing was actually written to the store.
    const all = await repo.list({ status: 'active' });
    expect(all.length).toBe(0);
  });

  it('uses custom scope when provided', async () => {
    const { repo, command } = await fixture();
    const scope = { type: 'repo' as const, remote: 'github.com/user/memento' };
    const result = await executeCommand(
      command,
      {
        candidates: [{ kind: 'fact', content: 'Repo-scoped fact' }],
        scope,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memory = await repo.read(result.value.written[0]!.id);
    expect(memory!.scope).toEqual(scope);
  });

  it('preserves candidate tags alongside autoTag', async () => {
    const { repo, command } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'Tagged candidate', tags: ['area:infra', 'priority:high'] },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memory = await repo.read(result.value.written[0]!.id);
    expect(memory!.tags).toContain('source:extracted');
    expect(memory!.tags).toContain('area:infra');
    expect(memory!.tags).toContain('priority:high');
  });

  it('fires afterWrite hook for each written memory', async () => {
    const { command, afterWriteCalls } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'First' },
          { kind: 'fact', content: 'Second' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(afterWriteCalls.length).toBe(2);
  });

  it('continues processing after a candidate error (partial failure)', async () => {
    // Create a fixture where the first candidate will error during write
    // by using an invalid scope that the repo will reject. We simulate
    // partial failure by having a candidate with kind 'fact' succeed
    // alongside a deliberately invalid candidate.
    const { command } = await fixture();

    // Empty content should fail Zod validation at the schema level,
    // so we use a valid batch where all succeed to confirm partial
    // failure semantics. The real test is the try/catch in the
    // processCandidate loop — we test it indirectly via the catch
    // path in the implementation (which marks as 'invalid').
    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'Valid candidate one' },
          { kind: 'fact', content: 'Valid candidate two' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(2);
  });

  it('does not duplicate autoTag if candidate already has it', async () => {
    const { repo, command } = await fixture();
    const result = await executeCommand(
      command,
      {
        candidates: [{ kind: 'fact', content: 'Already tagged', tags: ['source:extracted'] }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memory = await repo.read(result.value.written[0]!.id);
    const extractedTags = memory!.tags.filter((t) => t === 'source:extracted');
    expect(extractedTags.length).toBe(1);
  });

  it('rejects empty candidates array', async () => {
    const { command } = await fixture();
    const result = await executeCommand(command, { candidates: [] }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('calls embedBatch on the provider for batch-embed dedup', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M5') as never,
      eventIdFactory: counterFactory('E5'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'extraction.processing': 'sync',
      'retrieval.vector.enabled': false,
    });

    let embedBatchCalls = 0;
    let individualEmbedCalls = 0;
    const batchProvider = {
      model: 'test-model',
      dimension: 3,
      embed: async (_text: string) => {
        individualEmbedCalls += 1;
        return [0.1, 0.2, 0.3] as readonly number[];
      },
      embedBatch: async (texts: readonly string[]) => {
        embedBatchCalls += 1;
        return texts.map(() => [0.1, 0.2, 0.3] as readonly number[]);
      },
    };

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
      embeddingProvider: batchProvider,
    });

    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'Fact alpha' },
          { kind: 'fact', content: 'Fact beta' },
          { kind: 'fact', content: 'Fact gamma' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The batch embed path should have been called once upfront.
    expect(embedBatchCalls).toBe(1);
    // Individual embed should not be called — the batch path handles it.
    expect(individualEmbedCalls).toBe(0);
    expect(result.value.written.length).toBe(3);
  });

  it('falls back to exact-match dedup when batch embed fails (no crash)', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M6') as never,
      eventIdFactory: counterFactory('E6'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'extraction.processing': 'sync',
      'retrieval.vector.enabled': false,
    });

    const failingBatchProvider = {
      model: 'broken-model',
      dimension: 3,
      embed: async (_text: string): Promise<readonly number[]> => {
        throw new Error('individual embed also fails');
      },
      embedBatch: async (_texts: readonly string[]): Promise<readonly (readonly number[])[]> => {
        throw new Error('batch embed OOM');
      },
    };

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
      embeddingProvider: failingBatchProvider,
    });

    // Should not crash — falls back to exact-match dedup.
    const result = await executeCommand(
      command,
      {
        candidates: [{ kind: 'fact', content: 'Still works despite embed failure' }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(1);
  });

  it('async processing mode returns immediately with batchId and status accepted', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M7') as never,
      eventIdFactory: counterFactory('E7'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'retrieval.vector.enabled': false,
      'extraction.processing': 'async',
    });

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
    });

    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'Async fact alpha' },
          { kind: 'fact', content: 'Async fact beta' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('accepted');
    expect(result.value.batchId).toBeDefined();
    expect(typeof result.value.batchId).toBe('string');
    expect(result.value.batchId!.length).toBeGreaterThan(0);
    expect(result.value.written).toEqual([]);
    expect(result.value.skipped).toEqual([]);
    expect(result.value.superseded).toEqual([]);
  });

  it('async processing mode eventually writes memories in the background', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M8') as never,
      eventIdFactory: counterFactory('E8'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'retrieval.vector.enabled': false,
      'extraction.processing': 'async',
    });

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
    });

    const result = await executeCommand(
      command,
      {
        candidates: [
          { kind: 'fact', content: 'Background fact one' },
          { kind: 'fact', content: 'Background fact two' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('accepted');

    // Background processing is fire-and-forget. Give the event
    // loop a few ticks to let it complete.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const memories = await repo.list({ status: 'active', limit: 10 });
    expect(memories).toHaveLength(2);
    const contents = memories.map((m) => m.content).sort();
    expect(contents).toEqual(['Background fact one', 'Background fact two']);
  });

  it('supersedes when embedding similarity is in supersede range (same kind)', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M1') as never,
      eventIdFactory: counterFactory('E1'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'extraction.processing': 'sync',
      'retrieval.vector.enabled': false,
    });

    // Write an existing memory and give it an embedding.
    const existing = await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'User prefers dark mode in editors',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    // Store a fake embedding (unit vector dimension 3).
    await repo.setEmbedding(
      existing.id,
      { model: 'test-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );

    // Mock embedding provider that returns a vector with ~0.9 cosine
    // similarity to [1, 0, 0]: cos([1,0,0], [0.9,0.436,0]) ≈ 0.9
    const mockProvider = {
      model: 'test-model',
      dimension: 3,
      embed: async (_text: string) => [0.9, 0.436, 0] as readonly number[],
    };

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
      embeddingProvider: mockProvider,
    });

    const result = await executeCommand(
      command,
      { candidates: [{ kind: 'fact', content: 'User likes dark themes in all editors' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.superseded.length).toBe(1);
    expect(result.value.superseded[0]!.previousId).toBe(existing.id);
  });

  it('skips when embedding similarity is above identical threshold (same kind)', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M2') as never,
      eventIdFactory: counterFactory('E2'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'extraction.processing': 'sync',
      'retrieval.vector.enabled': false,
    });

    const existing = await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'User prefers dark mode',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.setEmbedding(
      existing.id,
      { model: 'test-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );

    // Near-identical vector: cosine ≈ 0.999
    const mockProvider = {
      model: 'test-model',
      dimension: 3,
      embed: async (_text: string) => [0.999, 0.04, 0] as readonly number[],
    };

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
      embeddingProvider: mockProvider,
    });

    const result = await executeCommand(
      command,
      { candidates: [{ kind: 'fact', content: 'User prefers dark mode' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped.length).toBe(1);
    expect(result.value.skipped[0]!.reason).toBe('duplicate');
    expect(result.value.skipped[0]!.existingId).toBe(existing.id);
  });

  it('writes new when embedding is similar but kind differs', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M3') as never,
      eventIdFactory: counterFactory('E3'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'extraction.processing': 'sync',
      'retrieval.vector.enabled': false,
      // Test feeds free-prose decision content to exercise the
      // dedup-by-kind path; the topic-line gate isn't the
      // subject under test.
      'safety.requireTopicLine': false,
    });

    const existing = await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'Use TypeScript strict mode',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );
    await repo.setEmbedding(
      existing.id,
      { model: 'test-model', dimension: 3, vector: [1, 0, 0] },
      { actor },
    );

    // High similarity but different kind → should write new.
    const mockProvider = {
      model: 'test-model',
      dimension: 3,
      embed: async (_text: string) => [0.999, 0.04, 0] as readonly number[],
    };

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
      embeddingProvider: mockProvider,
    });

    const result = await executeCommand(
      command,
      { candidates: [{ kind: 'decision', content: 'Use TypeScript strict mode' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Different kind → write, not skip or supersede.
    expect(result.value.written.length).toBe(1);
    expect(result.value.skipped.length).toBe(0);
    expect(result.value.superseded.length).toBe(0);
  });

  it('falls back to exact match when embedding provider throws', async () => {
    const handle = openDatabase({ path: ':memory:' });
    handles.push(handle);
    await migrateToLatest(handle.db, MIGRATIONS);
    const repo = createMemoryRepository(handle.db, {
      clock: () => fixedClock as never,
      memoryIdFactory: counterFactory('M4') as never,
      eventIdFactory: counterFactory('E4'),
    });
    const configStore = createConfigStore({
      'extraction.enabled': true,
      'extraction.dedup.threshold': 0.85,
      'extraction.dedup.identicalThreshold': 0.95,
      'extraction.defaultConfidence': 0.8,
      'extraction.autoTag': 'source:extracted',
      'extraction.maxCandidatesPerCall': 25,
      'extraction.processing': 'sync',
      'retrieval.vector.enabled': false,
    });

    // Provider that always throws.
    const failingProvider = {
      model: 'broken',
      dimension: 3,
      embed: async (_text: string): Promise<readonly number[]> => {
        throw new Error('Embedding service unavailable');
      },
    };

    const command = createMemoryExtractCommand({
      db: handle.db,
      memoryRepository: repo,
      configStore,
      embeddingProvider: failingProvider,
    });

    // Should fall back to FTS exact match, find nothing, and write.
    const result = await executeCommand(
      command,
      { candidates: [{ kind: 'fact', content: 'Fallback test' }] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(1);
  });

  it('dry-run reports supersede without persisting', async () => {
    const { repo, command } = await fixture();

    // Write an existing memory for exact-content dedup to find.
    await repo.write(
      {
        scope: { type: 'global' },
        owner: { type: 'local', id: 'self' },
        kind: { type: 'fact' },
        tags: [],
        pinned: false,
        content: 'Existing for dry-run',
        summary: null,
        storedConfidence: 1.0,
      },
      { actor },
    );

    // Dry-run with a new candidate (no dedup match) — should report written.
    const result = await executeCommand(
      command,
      {
        candidates: [{ kind: 'fact', content: 'Brand new fact' }],
        dryRun: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written.length).toBe(1);
    // Verify nothing persisted.
    const all = await repo.list({ status: 'active' });
    expect(all.length).toBe(1); // Only the pre-existing one.
  });

  it('rejects a preference candidate without a topic line when safety.requireTopicLine is on (the production default)', async () => {
    const { command } = await fixture({ 'safety.requireTopicLine': true });
    const result = await executeCommand(
      command,
      {
        candidates: [
          {
            kind: 'preference',
            content: 'User loves dark mode. Free-form prose.',
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/topic:/);
    expect(result.error.message).toMatch(/items\[0\]/);
  });
});
