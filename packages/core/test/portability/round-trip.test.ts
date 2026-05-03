// `@psraghuveer/memento-core/portability` round-trip + edge cases.
//
// The portability engine has two halves (`exportSnapshot`,
// `importSnapshot`) that have to agree on the artefact format
// byte-for-byte. This file exercises:
//
//   1. Round-trip: seed source DB → export → import into a fresh
//      DB → list and compare. Asserts full fidelity for memories
//      and their `created` audit events.
//   2. SHA-256 footer: corrupt one body byte, expect INVALID_INPUT.
//   3. Schema-version handshake: header.schemaVersion above the
//      runtime ceiling → CONFIG_ERROR.
//   4. Conflict policies: re-import the same artefact with `skip`
//      (idempotent) and with `abort` (CONFLICT).
//   5. Dry-run: returns counts without touching the DB.
//   6. Embeddings: included only when `--include-embeddings` is set.

import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';

import { exportSnapshot } from '../../src/portability/export.js';
import { importSnapshot } from '../../src/portability/import.js';
import { createMemoryRepository } from '../../src/repository/memory-repository.js';
import type { MemoryWriteInput } from '../../src/repository/memory-repository.js';
import { openDatabase } from '../../src/storage/database.js';
import { migrateToLatest } from '../../src/storage/migrate.js';
import { MIGRATIONS } from '../../src/storage/migrations/index.js';

interface OpenHandle {
  raw: ReturnType<typeof openDatabase>['raw'];
  db: ReturnType<typeof openDatabase>['db'];
  close(): void;
  path: string;
}

const handles: OpenHandle[] = [];

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
});

const actor: ActorRef = { type: 'cli' };

function makeWriter(): { lines: string[]; writer: { write(line: string): void } } {
  const lines: string[] = [];
  return {
    lines,
    writer: {
      write(line: string) {
        lines.push(line);
      },
    },
  };
}

async function fileBackedFixture(): Promise<OpenHandle> {
  // The export side opens the source DB by **path**, so we cannot
  // reuse a `:memory:` connection for round-trip tests. We use
  // `node:os.tmpdir()` per-test files instead.
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'memento-portability-'));
  const path = join(dir, 'memento.db');
  const handle = openDatabase({ path });
  await migrateToLatest(handle.db, MIGRATIONS);
  const wrapped: OpenHandle = {
    raw: handle.raw,
    db: handle.db,
    close: handle.close,
    path,
  };
  handles.push(wrapped);
  return wrapped;
}

const baseInput: MemoryWriteInput = {
  scope: { type: 'global' },
  owner: { type: 'local', id: 'tester' },
  kind: { type: 'fact' },
  tags: ['alpha'],
  pinned: false,
  content: 'meeting at 10am',
  summary: null,
  storedConfidence: 0.9,
};

async function seed(handle: OpenHandle, count: number): Promise<string[]> {
  const repo = createMemoryRepository(handle.db);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const memory = await repo.write(
      { ...baseInput, content: `memo ${i}`, tags: [`tag-${i}`] },
      { actor },
    );
    ids.push(memory.id);
  }
  return ids;
}

describe('exportSnapshot + importSnapshot — round-trip', () => {
  it('replays memories and their created events into a fresh DB', async () => {
    const source = await fileBackedFixture();
    const ids = await seed(source, 3);

    const cap = makeWriter();
    const summary = await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    expect(summary.counts.memories).toBe(3);
    expect(summary.counts.memoryEvents).toBe(3);
    expect(summary.counts.embeddings).toBe(0);
    expect(summary.sha256).toMatch(/^[0-9a-f]{64}$/);

    const target = await fileBackedFixture();
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied.memories).toBe(3);
    expect(result.value.applied.memoryEvents).toBe(3);
    expect(result.value.dryRun).toBe(false);

    // Compare memory rows.
    const repo = createMemoryRepository(target.db);
    const replayed = await repo.list();
    expect(replayed.map((m) => m.id).sort()).toEqual([...ids].sort());
    for (const memory of replayed) {
      expect(memory.status).toBe('active');
      expect(memory.embedding).toBeNull();
    }
  });

  it('--dry-run returns counts without writing to the DB', async () => {
    const source = await fileBackedFixture();
    await seed(source, 2);
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });

    const target = await fileBackedFixture();
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dryRun).toBe(true);
    expect(result.value.applied.memories).toBe(2);

    const count = target.raw.prepare('select count(*) as n from memories').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("--on-conflict='skip' is idempotent on re-import", async () => {
    const source = await fileBackedFixture();
    await seed(source, 2);
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const target = await fileBackedFixture();
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));

    const first = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'skip',
      dryRun: false,
    });
    expect(first.ok).toBe(true);
    const second = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'skip',
      dryRun: false,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.skipped.memories).toBe(2);
    expect(second.value.applied.memories).toBe(0);

    const count = target.raw.prepare('select count(*) as n from memories').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("--on-conflict='abort' returns CONFLICT on re-import", async () => {
    const source = await fileBackedFixture();
    await seed(source, 1);
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const target = await fileBackedFixture();
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));

    await importSnapshot({ db: target.db, source: lines, onConflict: 'abort', dryRun: false });
    const second = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('CONFLICT');
  });

  it('round-trips embeddings when --include-embeddings is set', async () => {
    const source = await fileBackedFixture();
    const repo = createMemoryRepository(source.db);
    const memory = await repo.write(baseInput, { actor });
    await repo.setEmbedding(
      memory.id,
      {
        model: 'bge-small-en-v1.5',
        dimension: 4,
        vector: [0.1, 0.2, 0.3, 0.4],
      },
      { actor },
    );

    const cap = makeWriter();
    const summary = await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: true,
      mementoVersion: '0.0.0-test',
    });
    expect(summary.counts.embeddings).toBe(1);

    const target = await fileBackedFixture();
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied.embeddings).toBe(1);

    const targetRepo = createMemoryRepository(target.db);
    const replayed = await targetRepo.read(memory.id);
    expect(replayed?.embedding).toMatchObject({
      model: 'bge-small-en-v1.5',
      dimension: 4,
      vector: [0.1, 0.2, 0.3, 0.4],
    });
    expect(replayed?.embedding?.createdAt).toBeDefined();
  });
});

describe('importSnapshot — validation', () => {
  it('rejects an artefact whose body has been corrupted (sha256 mismatch)', async () => {
    const source = await fileBackedFixture();
    await seed(source, 1);
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));
    // Tamper with the first body line — `JSON.parse` should still
    // succeed, so this isolates the SHA-256 check.
    const tampered = lines[1]!.replace('memo 0', 'memo X');
    expect(tampered).not.toBe(lines[1]);
    const corrupt = [lines[0]!, tampered, ...lines.slice(2)];

    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: corrupt,
      onConflict: 'abort',
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('SHA-256');
  });

  it('rejects an artefact authored against a newer schema version', async () => {
    const source = await fileBackedFixture();
    await seed(source, 1);
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));
    // Hand-craft a header with an artificially high schemaVersion
    // and recompute the footer over it so only the version check
    // (not the integrity check) fires.
    const { createHash } = await import('node:crypto');
    const headerObj = JSON.parse(lines[0]!) as { schemaVersion: number };
    headerObj.schemaVersion = 9999;
    const newHeader = JSON.stringify(headerObj);
    const hash = createHash('sha256');
    hash.update(`${newHeader}\n`);
    for (const body of lines.slice(1, -1)) hash.update(`${body}\n`);
    const newFooter = JSON.stringify({ type: 'footer', sha256: hash.digest('hex') });
    const futureLines = [newHeader, ...lines.slice(1, -1), newFooter];

    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: futureLines,
      onConflict: 'abort',
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG_ERROR');
  });

  it('rejects an artefact with fewer than two lines', async () => {
    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: [],
      onConflict: 'abort',
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });
});

describe('importSnapshot — re-stamp policy (ADR-0019)', () => {
  // Phase 4 hardening: imports never trust the artefact's audit
  // claims. OwnerRef is rewritten, content is re-scrubbed, and
  // (under default settings) the per-memory event chain is
  // collapsed into one synthetic `memory.imported` event.

  it('rewrites OwnerRef to local-self even when the artefact claims otherwise', async () => {
    const source = await fileBackedFixture();
    const repo = createMemoryRepository(source.db);
    // The MemoryWriteInput type requires owner to be `OwnerRef`.
    // The repo's local mode accepts only local-self, but here we
    // hand-craft a memory that *claims* a non-local owner by
    // directly editing the JSONL line after export.
    await repo.write(baseInput, { actor });
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));
    // Find the memory record line and rewrite its owner. We
    // recompute the footer over the new header+body so the SHA
    // check passes; only the re-stamp policy should fire.
    const memoryIdx = lines.findIndex((l) => l.includes('"type":"memory"'));
    expect(memoryIdx).toBeGreaterThan(0);
    const memoryRec = JSON.parse(lines[memoryIdx]!) as {
      type: 'memory';
      data: { owner: { type: string; id: string } };
    };
    memoryRec.data.owner = { type: 'team', id: 'attacker' };
    lines[memoryIdx] = JSON.stringify(memoryRec);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    hash.update(`${lines[0]}\n`);
    for (const l of lines.slice(1, -1)) hash.update(`${l}\n`);
    lines[lines.length - 1] = JSON.stringify({ type: 'footer', sha256: hash.digest('hex') });

    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const targetRepo = createMemoryRepository(target.db);
    const replayed = await targetRepo.list();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.owner).toEqual({ type: 'local', id: 'self' });
  });

  it('collapses the per-memory event chain into a single `imported` event by default', async () => {
    const source = await fileBackedFixture();
    const repo = createMemoryRepository(source.db);
    const m = await repo.write(baseInput, { actor });
    // Multiple confirms produce additional events on the source.
    await repo.confirm(m.id, { actor });
    await repo.confirm(m.id, { actor });
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));

    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One synthetic event per imported memory, regardless of how
    // many real events the artefact carried.
    expect(result.value.applied.memoryEvents).toBe(1);

    const events = target.raw
      .prepare('select type, payload_json from memory_events where memory_id = ?')
      .all(m.id) as Array<{ type: string; payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('imported');
    const payload = JSON.parse(events[0]!.payload_json) as {
      source: { mementoVersion: string };
      originalEvents: unknown[];
    };
    expect(payload.source.mementoVersion).toBe('0.0.0-test');
    // Original events ride along as opaque data — three on the
    // source (created + 2 × confirmed).
    expect(payload.originalEvents).toHaveLength(3);
  });

  it('preserves the original event chain when --trust-source is set', async () => {
    const source = await fileBackedFixture();
    const repo = createMemoryRepository(source.db);
    const m = await repo.write(baseInput, { actor });
    await repo.confirm(m.id, { actor });
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));

    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
      trustSource: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied.memoryEvents).toBe(2);

    const types = (
      target.raw
        .prepare('select type from memory_events where memory_id = ? order by id')
        .all(m.id) as Array<{ type: string }>
    ).map((r) => r.type);
    expect(types).toEqual(['created', 'confirmed']);
  });

  it('re-scrubs content with the importer rules even when the source had a stricter scrubber', async () => {
    // Source machine: scrubber off (e.g. an export from a host
    // configured to bypass scrubbing). Target: real rules.
    const source = await fileBackedFixture();
    const repo = createMemoryRepository(source.db);
    await repo.write({ ...baseInput, content: 'leaked sk-IMPORT123 token' }, { actor });
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));

    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
      scrubber: {
        rules: [
          {
            id: 'test-secret',
            description: 'fake',
            pattern: 'sk-[A-Za-z0-9]{6,}',
            placeholder: '<r:{{rule.id}}>',
            severity: 'high',
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    const targetRepo = createMemoryRepository(target.db);
    const replayed = (await targetRepo.list())[0];
    expect(replayed?.content).toContain('<r:test-secret>');
    expect(replayed?.content).not.toContain('IMPORT123');
  });

  it('rejects an artefact whose memory_event payload exceeds maxRecordBytes', async () => {
    const source = await fileBackedFixture();
    const repo = createMemoryRepository(source.db);
    const m = await repo.write(baseInput, { actor });
    // Forget produces an event with a `reason` payload — the
    // schema caps `reason` at 512 chars, so we use the actual cap
    // value to make the event payload sizable but legal.
    await repo.forget(m.id, 'a'.repeat(400), { actor });
    const cap = makeWriter();
    await exportSnapshot({
      dbPath: source.path,
      writer: cap.writer,
      includeEmbeddings: false,
      mementoVersion: '0.0.0-test',
    });
    const lines = cap.lines.map((l) => l.replace(/\n$/, ''));

    const target = await fileBackedFixture();
    const result = await importSnapshot({
      db: target.db,
      source: lines,
      onConflict: 'abort',
      dryRun: false,
      // The forget event's payload is `{"reason":"<400 chars>"}`
      // ≈ 412 bytes. A 64-byte cap rejects.
      maxRecordBytes: 64,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/exceeds maxRecordBytes/u);
  });
});
