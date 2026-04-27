// WAL-mode concurrency smoke test (Phase 3g).
//
// `openDatabase` enables `journal_mode = WAL` for every
// file-backed database so multiple processes / instances can
// share a single sqlite file: many readers and a single writer
// at any given moment, plus a `busy_timeout` that lets a second
// writer wait briefly instead of failing immediately.
//
// This test pins that behaviour at the engine level: two
// `createMementoApp` instances opened on the same on-disk path
// can interleave writes and both observe each other's rows.
// It guards the WAL pragma against accidental regression and
// catches FK / migration drift between concurrent openers.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActorRef } from '@psraghuveer/memento-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type MementoApp, createMementoApp } from '../../src/bootstrap.js';
import { rmTmpSync } from '../_helpers/rm-tmp.js';

const apps: MementoApp[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (apps.length > 0) {
    apps.pop()?.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmTmpSync(dir);
    }
  }
});

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memento-wal-'));
  dirs.push(dir);
  return join(dir, 'memento.sqlite');
}

const actor: ActorRef = { type: 'cli' };

const baseInput = {
  scope: { type: 'global' as const },
  owner: { type: 'local' as const, id: 'tester' },
  kind: { type: 'fact' as const },
  tags: [] as string[],
  pinned: false,
  summary: null,
  storedConfidence: 0.9,
};

describe('WAL-mode concurrent access', () => {
  it('two MementoApp instances on the same file can both write and read', async () => {
    const path = freshDbPath();
    const a = await createMementoApp({ dbPath: path });
    apps.push(a);
    const b = await createMementoApp({ dbPath: path });
    apps.push(b);

    // Pin the pragma we depend on: both openers must be in WAL.
    // Without this, the rest of the test would still pass on a
    // rollback-journal database but would no longer guard the
    // concurrency story we actually care about.
    expect(String(a.db.raw.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(String(b.db.raw.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');

    // Interleave writes: A, B, A, B. Each call goes through the
    // repository's transaction, so on the wire it serialises as
    // four short writer locks. With WAL + busy_timeout, the
    // second writer waits instead of failing.
    const a1 = await a.memoryRepository.write({ ...baseInput, content: 'from-a-1' }, { actor });
    const b1 = await b.memoryRepository.write({ ...baseInput, content: 'from-b-1' }, { actor });
    const a2 = await a.memoryRepository.write({ ...baseInput, content: 'from-a-2' }, { actor });
    const b2 = await b.memoryRepository.write({ ...baseInput, content: 'from-b-2' }, { actor });

    // Each instance sees every row regardless of which opener
    // wrote it. WAL gives readers a consistent snapshot taken
    // after the most recent commit they observed.
    const fromA = await a.memoryRepository.list({});
    const fromB = await b.memoryRepository.list({});
    const idsFromA = new Set(fromA.map((m) => m.id));
    const idsFromB = new Set(fromB.map((m) => m.id));
    for (const id of [a1.id, a2.id, b1.id, b2.id]) {
      expect(idsFromA.has(id)).toBe(true);
      expect(idsFromB.has(id)).toBe(true);
    }
  });
});
