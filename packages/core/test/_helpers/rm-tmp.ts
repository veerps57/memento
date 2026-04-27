// Windows-safe temp-dir cleanup.
//
// better-sqlite3 closes synchronously, but on Windows the OS may
// hold the file mapping for a few milliseconds after the JS
// `close()` returns. A naive `rmSync` then fails with EBUSY. We
// retry briefly with a short sleep — long enough for the handle
// to drop, short enough that healthy CI runs don't slow down.

import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const ATTEMPTS = 50;
const DELAY_MS = 200;

function isBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';
}

// Real thread-park sleep that yields to the OS scheduler. Required on
// Windows so the kernel can finalise pending file-handle releases
// after better-sqlite3 closes a WAL-mode DB.
function sleepBlocking(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export function rmTmpSync(dir: string): void {
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!isBusy(err) || i === ATTEMPTS - 1) throw err;
      sleepBlocking(DELAY_MS);
    }
  }
}

export async function rmTmp(dir: string): Promise<void> {
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!isBusy(err) || i === ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
}
