// `memento dashboard` lifecycle command tests.
//
// `runDashboard` blocks on SIGINT in production, so the
// untestable surface (HTTP bind, browser open, signal wait) was
// extracted into `LifecycleDeps.launchDashboard` (analogous to
// `serveStdio` for `runServe`). Tests inject a fake launcher
// that resolves immediately; `runDashboard` is otherwise pure
// logic: parse subargs, open the app, hand off to the launcher,
// close the app, return the snapshot.
//
// What we pin:
//
//   - parseDashboardSubargs covers every flag (success + failure)
//   - runDashboard wires the launcher correctly (registry, ctx,
//     port, host, shouldOpen, version, io)
//   - the launcher's returned URL/port/host/opened flow into the
//     snapshot verbatim
//   - app.close() runs exactly once, including when the
//     launcher throws (we catch and rethrow paths only —
//     production wraps the throw as INTERNAL upstream)
//   - createApp throw → STORAGE_ERROR (mirrors runServe)
//   - missing launchDashboard dep → INTERNAL (host
//     misconfiguration)
//   - subarg parse failures bubble through with INVALID_INPUT
//     before the app is opened

import { type CreateMementoAppOptions, createMementoApp } from '@psraghuveer/memento-core';
import { describe, expect, it } from 'vitest';

import type { CliEnv } from '../src/argv.js';
import type { CliIO } from '../src/io.js';
import { parseDashboardSubargs, runDashboard } from '../src/lifecycle/dashboard.js';
import type { LaunchDashboardOptions, LifecycleDeps } from '../src/lifecycle/types.js';

const createAppNoVector: typeof createMementoApp = (opts: CreateMementoAppOptions) =>
  createMementoApp({
    ...opts,
    configOverrides: { ...opts?.configOverrides, 'retrieval.vector.enabled': false },
  });

const NULL_IO: CliIO = {
  argv: [],
  env: {},
  stdin: process.stdin,
  stdout: { write: () => undefined },
  stderr: { write: () => undefined },
  isTTY: false,
  isStderrTTY: false,
  exit: ((code: number): never => {
    throw new Error(`unexpected exit ${code}`);
  }) as CliIO['exit'],
};

const cliEnv = (overrides: Partial<CliEnv> = {}): CliEnv => ({
  dbPath: ':memory:',
  format: 'json',
  debug: false,
  ...overrides,
});

const rejectMigrateStore: LifecycleDeps['migrateStore'] = async () => {
  throw new Error('migrateStore should not be called from runDashboard');
};

const rejectServeStdio: LifecycleDeps['serveStdio'] = async () => {
  throw new Error('serveStdio should not be called from runDashboard');
};

/**
 * Build a fake `launchDashboard` that records the options it
 * was called with and returns a synthetic result. The recorded
 * `calls` array lets a single test assert several aspects of
 * the wiring (host, port, shouldOpen, version, ctx) without
 * stubbing each one separately.
 */
function fakeLauncher(
  result?: Partial<{
    url: string;
    port: number;
    host: string;
    opened: boolean;
  }>,
): {
  launch: NonNullable<LifecycleDeps['launchDashboard']>;
  calls: LaunchDashboardOptions[];
} {
  const calls: LaunchDashboardOptions[] = [];
  const launch: NonNullable<LifecycleDeps['launchDashboard']> = async (options) => {
    calls.push(options);
    return {
      url: result?.url ?? 'http://localhost:51234',
      port: result?.port ?? 51234,
      host: result?.host ?? options.host,
      opened: result?.opened ?? options.shouldOpen,
    };
  };
  return { launch, calls };
}

describe('parseDashboardSubargs', () => {
  it('returns the documented defaults when no subargs are passed', () => {
    const r = parseDashboardSubargs([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ port: 0, host: '127.0.0.1', open: true });
  });

  it('accepts --port with a separate argument', () => {
    const r = parseDashboardSubargs(['--port', '4747']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.port).toBe(4747);
  });

  it('accepts --port with an inline =value', () => {
    const r = parseDashboardSubargs(['--port=8080']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.port).toBe(8080);
  });

  it('rejects --port without a value', () => {
    const r = parseDashboardSubargs(['--port']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(r.error.message).toContain('--port requires a value');
  });

  it('rejects --port with a non-numeric value', () => {
    const r = parseDashboardSubargs(['--port', 'abc']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(r.error.message).toContain('integer in 0..65535');
  });

  it('rejects --port outside 0..65535', () => {
    const r = parseDashboardSubargs(['--port', '99999']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('accepts --host 127.0.0.1', () => {
    const r = parseDashboardSubargs(['--host', '127.0.0.1']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.host).toBe('127.0.0.1');
  });

  it('canonicalises --host localhost to 127.0.0.1 (the bound socket is always 127.0.0.1)', () => {
    const r = parseDashboardSubargs(['--host', 'localhost']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.host).toBe('127.0.0.1');
  });

  it('rejects --host with any other value', () => {
    const r = parseDashboardSubargs(['--host', '0.0.0.0']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(r.error.message).toContain('single-user');
  });

  it('rejects --host without a value', () => {
    const r = parseDashboardSubargs(['--host']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('flips the open flag with --no-open', () => {
    const r = parseDashboardSubargs(['--no-open']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.open).toBe(false);
  });

  it('flips it back with --open (last write wins)', () => {
    const r = parseDashboardSubargs(['--no-open', '--open']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.open).toBe(true);
  });

  it('rejects an unknown flag with a hint listing accepted flags', () => {
    const r = parseDashboardSubargs(['--bogus']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_INPUT');
    expect(r.error.message).toContain('--port');
    expect(r.error.message).toContain('--host');
    expect(r.error.message).toContain('--no-open');
  });
});

describe('runDashboard', () => {
  it('wires every launch option correctly and forwards the launcher result into the snapshot', async () => {
    const { launch, calls } = fakeLauncher({
      url: 'http://localhost:4747',
      port: 4747,
      host: '127.0.0.1',
      opened: true,
    });
    const result = await runDashboard(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        launchDashboard: launch,
      },
      { env: cliEnv(), subargs: ['--port', '4747', '--no-open', '--open'], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Snapshot reflects the launcher's response verbatim.
    expect(result.value.url).toBe('http://localhost:4747');
    expect(result.value.port).toBe(4747);
    expect(result.value.host).toBe('127.0.0.1');
    expect(result.value.opened).toBe(true);
    expect(typeof result.value.version).toBe('string');
    expect(result.value.version.length).toBeGreaterThan(0);

    // Launcher saw the wire-up the lifecycle promised it.
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) return;
    expect(call.port).toBe(4747);
    expect(call.host).toBe('127.0.0.1');
    expect(call.shouldOpen).toBe(true);
    expect(call.ctx.actor).toEqual({ type: 'cli' });
    expect(call.io).toBe(NULL_IO);
    expect(call.version).toBe(result.value.version);
    // The registry the launcher receives is the live one from the
    // app — not a stub. Spot-check by looking up a known command.
    expect(call.registry.get('memory.write')).toBeDefined();
  });

  it('honours --no-open by passing shouldOpen=false to the launcher', async () => {
    const { launch, calls } = fakeLauncher({ opened: false });
    const result = await runDashboard(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        launchDashboard: launch,
      },
      { env: cliEnv(), subargs: ['--no-open'], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.shouldOpen).toBe(false);
  });

  it('canonicalises --host localhost to 127.0.0.1 before handing off', async () => {
    const { launch, calls } = fakeLauncher();
    const result = await runDashboard(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        launchDashboard: launch,
      },
      { env: cliEnv(), subargs: ['--host', 'localhost'], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.host).toBe('127.0.0.1');
  });

  it('returns INVALID_INPUT before opening the app when subargs are bad', async () => {
    let createAppCalled = false;
    const result = await runDashboard(
      {
        createApp: async (opts) => {
          createAppCalled = true;
          return createAppNoVector(opts);
        },
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        launchDashboard: async () => {
          throw new Error('launchDashboard should not be reached on parse failure');
        },
      },
      { env: cliEnv(), subargs: ['--port', 'not-a-number'], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    // Critical: failing parse must not open the database. A bad
    // arg should cost zero side effects.
    expect(createAppCalled).toBe(false);
  });

  it('returns INTERNAL when the host did not wire launchDashboard', async () => {
    const result = await runDashboard(
      {
        createApp: createAppNoVector,
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        // launchDashboard intentionally omitted — exercises the
        // "host misconfiguration" branch.
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.message).toContain('launchDashboard');
  });

  it('returns STORAGE_ERROR when createApp throws', async () => {
    const { launch } = fakeLauncher();
    const result = await runDashboard(
      {
        createApp: async () => {
          throw new Error('disk on fire');
        },
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        launchDashboard: launch,
      },
      { env: cliEnv({ dbPath: '/no/such/path.db' }), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STORAGE_ERROR');
    expect(result.error.message).toContain('disk on fire');
  });

  it('closes the app exactly once after a successful launch', async () => {
    let closed = 0;
    const real = await createAppNoVector({ dbPath: ':memory:' });
    const { launch } = fakeLauncher();
    const result = await runDashboard(
      {
        createApp: async () => ({
          ...real,
          close: () => {
            closed += 1;
            real.close();
          },
        }),
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        launchDashboard: launch,
      },
      { env: cliEnv(), subargs: [], io: NULL_IO },
    );
    expect(result.ok).toBe(true);
    expect(closed).toBe(1);
  });

  it('returns INTERNAL and still closes the app when the launcher throws', async () => {
    // Production hazards: port conflict, killed `open` binary, a
    // broken `@hono/node-server` import. The lifecycle command
    // must not leak the DB handle on any of those — try/finally.
    let closed = 0;
    const real = await createAppNoVector({ dbPath: ':memory:' });
    const result = await runDashboard(
      {
        createApp: async () => ({
          ...real,
          close: () => {
            closed += 1;
            real.close();
          },
        }),
        migrateStore: rejectMigrateStore,
        serveStdio: rejectServeStdio,
        launchDashboard: async () => {
          throw new Error('EADDRINUSE: port already in use');
        },
      },
      { env: cliEnv(), subargs: ['--port', '4747'], io: NULL_IO },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.message).toContain('EADDRINUSE');
    expect(closed).toBe(1);
  });
});
