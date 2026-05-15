// Composition root for `@psraghuveer/memento-core`.
//
// `createMementoApp` is the single place where the engine's
// pieces are stitched together: open the database, run
// migrations, build a `ConfigStore`, instantiate the three
// repositories, wire `runConflictHook` as the `afterWrite` hook
// on the `memory.*` command set, build the `memory.search`
// command, and freeze a `CommandRegistry` containing the full
// v1 command universe.
//
// Everything above this layer (the MCP adapter in
// `@psraghuveer/memento-server`, the CLI adapter in `@psraghuveer/memento`,
// integration tests, the future `npx memento` binary) consumes
// the returned `{ registry, db, configStore, … }` and is
// transport-agnostic.
//
// Design notes:
//
//   - The conflict hook is wired here (and only here) because
//     this is the layer that owns both the `ConflictRepository`
//     and the `ConfigStore` from which `conflict.enabled` /
//     `conflict.timeoutMs` / `conflict.scopeStrategy` /
//     `conflict.detector.maxCandidates` are sourced. The hook
//     is fire-and-forget per ADR-0005: the returned promise is
//     intentionally not awaited — `runConflictHook` is
//     non-throwing, so an orphaned rejection is impossible.
//
//   - The embedding command is registered only when an
//     `EmbeddingProvider` is supplied. v1 ships without a
//     bundled provider (`@psraghuveer/memento-embedder-local` is empty per
//     KNOWN_LIMITATIONS.md), so a host that wants
//     `embedding.rebuild` brings its own. Hosts without a
//     provider get a registry where `embedding.rebuild` is
//     simply absent rather than registered-and-broken.
//
//   - Scrubber rules and the master enable flag flow from
//     `scrubber.rules` / `scrubber.enabled` on the config store.
//     The defaults are `DEFAULT_SCRUBBER_RULES` and `true`
//     respectively; operators override either via
//     `configOverrides` or — once persistence lands — via
//     `config.set`.
//
//   - The function is `async` only because `migrateToLatest`
//     returns a Promise. All other steps are synchronous.

import { MEMORY_SCHEMA_VERSION } from '@psraghuveer/memento-schema';
import {
  createCompactCommands,
  createConfigCommands,
  createConflictCommands,
  createEmbeddingCommands,
  createMemoryCommands,
  createMemoryContextCommand,
  createMemoryExtractCommand,
  createMemorySearchCommand,
  createPackCommands,
  createRegistry,
  createSystemCommands,
} from './commands/index.js';
import type { CommandRegistry } from './commands/index.js';
import type { ConfigOverrides, ConfigRepository, ConfigStore } from './config/index.js';
import { createConfigRepository, createMutableConfigStore } from './config/index.js';
import type { ConflictHookConfig, ConflictRepository } from './conflict/index.js';
import { createConflictRepository, runConflictHook } from './conflict/index.js';
import type { EmbeddingProvider } from './embedding/index.js';
import { embedAndStore, reembedAll } from './embedding/index.js';
import { createDefaultPackSourceResolver } from './packs/index.js';
import type { EventRepository, MemoryRepository } from './repository/index.js';
import { createEventRepository, createMemoryRepository } from './repository/index.js';
import type { MementoDatabase } from './storage/index.js';
import { MIGRATIONS, migrateToLatest, openDatabase } from './storage/index.js';

/**
 * Inputs to {@link createMementoApp}.
 *
 * Exactly one of `dbPath` / `database` must be supplied:
 *   - `dbPath` opens a fresh handle (and closes it in
 *     {@link MementoApp.close}). Use `':memory:'` for tests.
 *   - `database` adopts a pre-opened handle. The caller stays
 *     responsible for closing it; {@link MementoApp.close}
 *     becomes a no-op for the database itself.
 */
export interface CreateMementoAppOptions {
  readonly dbPath?: string;
  readonly database?: MementoDatabase;
  /** Overrides applied on top of `CONFIG_KEYS` defaults. */
  readonly configOverrides?: ConfigOverrides;
  /**
   * Optional embedding provider. When omitted, the
   * `embedding.rebuild` command is absent from the registry.
   * When supplied, hosts get a fully-functional rebuild path.
   */
  readonly embeddingProvider?: EmbeddingProvider;
  /**
   * Memento package version reported by `system.info`. Threaded
   * through from the host (CLI/server reads its own
   * `package.json`); when omitted, `system.info` returns
   * `'unknown'`. Treated as a hint, not a contract — clients
   * MUST NOT branch on the format.
   */
  readonly appVersion?: string;
}

/**
 * Handle returned by {@link createMementoApp}. Holds every
 * subsystem an adapter or test might need to reach for, plus an
 * idempotent `close`.
 */
export interface MementoApp {
  readonly registry: CommandRegistry;
  readonly db: MementoDatabase;
  readonly configStore: ConfigStore;
  readonly memoryRepository: MemoryRepository;
  readonly eventRepository: EventRepository;
  readonly conflictRepository: ConflictRepository;
  readonly configRepository: ConfigRepository;
  /**
   * The wired embedding provider, when one was supplied. Hosts
   * use this to compose post-write batch-embed operations that
   * need to outlive the command's request scope (e.g. CLI
   * `memento import`'s post-commit embed pass — see ADR-0021).
   * `undefined` when the host opted out of vector retrieval
   * (`retrieval.vector.enabled = false` or no provider passed).
   */
  readonly embeddingProvider?: EmbeddingProvider;
  /**
   * Idempotent synchronous close. Releases the database handle iff
   * this app opened it. Does **not** wait for background work — the
   * startup embedding backfill (ADR-0021) may still be mid-batch when
   * `close()` returns, which is fine for embedded callers that
   * coordinate teardown another way (tests, in-process integrations).
   * Hosts that run signal-driven lifecycle commands (`dashboard`,
   * `serve`) should prefer {@link MementoApp.shutdown} so the
   * embedder's native worker threads aren't torn down mid-inference.
   */
  close(): void;
  /**
   * Graceful shutdown for signal-driven lifecycles. Awaits every
   * tracked background task — post-write conflict hooks
   * (ADR-0005), post-write auto-embed, the startup backfill
   * (ADR-0021), and the embedder warmup — up to
   * `embedding.startupBackfill.shutdownGraceMs`, then runs the
   * standard {@link MementoApp.close} synchronously. Idempotent
   * and never throws — each tracked task already swallows its
   * own errors and the tracker adds a defensive catch on top, so
   * shutdown's failure mode is "timed out waiting for the work to
   * drain", not "rejected". The grace window stops Ctrl-C from
   * racing the embedder's ONNX worker threads, which otherwise
   * abort the process with `libc++abi: mutex lock failed: Invalid
   * argument` (ADR-0023 / ADR-0024).
   */
  shutdown(): Promise<void>;
}

/**
 * Build a fully-wired Memento engine instance.
 *
 * Steps, in order:
 *   1. Open (or adopt) the SQLite database.
 *   2. Run all registered migrations.
 *   3. Build the `ConfigStore` from the supplied overrides.
 *   4. Construct the three repositories.
 *   5. Build the `memory.*` command set with `runConflictHook`
 *      wired as the `afterWrite` hook.
 *   6. Build the `memory.search` command (it has separate deps
 *      from the rest of `memory.*`; see `commands/memory/search.ts`).
 *   7. Build `conflict.*`, `compact.*`, and (if a provider is
 *      supplied) `embedding.*` command sets.
 *   8. Register everything into a frozen registry.
 */
export async function createMementoApp(options: CreateMementoAppOptions): Promise<MementoApp> {
  const { database, dbPath, configOverrides, embeddingProvider, appVersion } = options;
  if ((database === undefined) === (dbPath === undefined)) {
    throw new Error(
      "createMementoApp: supply exactly one of 'dbPath' or 'database' (got both or neither).",
    );
  }

  const ownsDatabase = database === undefined;
  const db = database ?? openDatabase({ path: dbPath as string });

  await migrateToLatest(db.db, MIGRATIONS);

  // Config persistence: load the runtime layer from
  // `config_events` before instantiating any subsystem that
  // reads from the store. The mutable store layers persisted
  // events on top of `configOverrides` (attributed to source
  // `cli`), which themselves layer on top of the registry
  // defaults — see `createMutableConfigStore` for the
  // precedence rules.
  const configRepository = createConfigRepository(db.db);
  const persisted = await configRepository.currentValues();
  const configStore = createMutableConfigStore({
    ...(configOverrides !== undefined ? { baseOverrides: configOverrides } : {}),
    persisted,
  });

  const memoryRepository = createMemoryRepository(db.db, {
    scrubber: {
      rules: configStore.get('scrubber.rules'),
      enabled: configStore.get('scrubber.enabled'),
      engineBudgetMs: configStore.get('scrubber.engineBudgetMs'),
    },
  });
  const eventRepository = createEventRepository(db.db);
  const conflictRepository = createConflictRepository(db.db);

  const hookConfig: ConflictHookConfig = {
    enabled: configStore.get('conflict.enabled'),
    timeoutMs: configStore.get('conflict.timeoutMs'),
    // `conflict.scopeStrategy` is a `z.enum(['same', 'effective'])`
    // but `defineKey`'s inference widens the value to `string` via
    // its `default` field. The schema enforces the narrow set at
    // override time, so the cast is sound.
    scopeStrategy: configStore.get('conflict.scopeStrategy') as 'same' | 'effective',
  };
  const maxCandidates = configStore.get('conflict.detector.maxCandidates');

  // Background work tracker — every fire-and-forget async task that
  // `createMementoApp` kicks off (post-write conflict hooks, auto-embed,
  // the startup backfill, the embedder warmup) registers here so
  // `shutdown` can drain the lot before closing the database. Critical
  // for the ONNX embedder: tearing down its worker threads while one is
  // mid-inference (or mid-warmup) aborts the process with
  // `libc++abi: terminating due to uncaught exception of type
  // std::__1::system_error: mutex lock failed: Invalid argument`. The
  // set self-prunes — every tracked promise is wrapped in a catch +
  // finally that removes it on settle — so memory stays bounded over
  // long-lived sessions even with thousands of writes.
  const pendingBackgroundWork = new Set<Promise<unknown>>();
  const trackBackgroundWork = (promise: Promise<unknown>): void => {
    // Catch defensively so a rejection from a tracked task never
    // produces an unhandled-promise-rejection warning. Background
    // work is best-effort by definition; each call site already has
    // its own error-handling story (most use a try/catch around the
    // inner body, and `runConflictHook` is non-throwing by contract).
    const wrapped = promise.catch(() => {});
    pendingBackgroundWork.add(wrapped);
    wrapped.finally(() => {
      pendingBackgroundWork.delete(wrapped);
    });
  };

  const memoryCommands = createMemoryCommands(
    memoryRepository,
    {
      afterWrite: (memory, ctx) => {
        // Fire-and-forget per ADR-0005. `runConflictHook` is
        // non-throwing — every failure mode is folded into its
        // returned outcome — but we still register the promise with
        // the background-work tracker so `shutdown` can drain it
        // before closing native handles.
        trackBackgroundWork(
          runConflictHook(memory, { memoryRepository, conflictRepository }, hookConfig, {
            actor: ctx.actor,
            maxCandidates,
          }),
        );
        // Auto-embed: fire-and-forget, same pattern as conflict hook.
        // Guarded by provider presence + config flag. Errors are
        // swallowed — embedding is best-effort; the memory is already
        // persisted. The user can always run `embedding rebuild` later.
        // The promise is tracked so a SIGINT during inference does not
        // race the ONNX worker-thread teardown (ADR-0023 / ADR-0024).
        if (embeddingProvider !== undefined && configStore.get('embedding.autoEmbed')) {
          trackBackgroundWork(
            (async () => {
              try {
                const vector = await embeddingProvider.embed(memory.content);
                await memoryRepository.setEmbedding(
                  memory.id,
                  {
                    model: embeddingProvider.model,
                    dimension: embeddingProvider.dimension,
                    vector,
                  },
                  { actor: ctx.actor },
                );
              } catch {
                // Best-effort: embedding failure must never surface
                // to the caller. The memory is written; vector search
                // will simply not find it until a successful re-embed.
              }
            })(),
          );
        }
      },
    },
    {
      eventRepository,
      configStore,
      ...(embeddingProvider !== undefined
        ? {
            configuredEmbedder: {
              model: embeddingProvider.model,
              dimension: embeddingProvider.dimension,
            },
          }
        : {}),
    },
  );
  const searchCommand = createMemorySearchCommand({
    db: db.db,
    memoryRepository,
    configStore,
    conflictRepository,
    // Thread the provider through so `retrieval.vector.enabled`
    // has something to call. When omitted, flipping the flag on
    // surfaces a structured CONFIG_ERROR (see pipeline.ts), so
    // hosts that don't run a vector backend stay correct by
    // construction.
    ...(embeddingProvider !== undefined ? { embeddingProvider } : {}),
  });
  const contextCommand = createMemoryContextCommand({
    db: db.db,
    memoryRepository,
    configStore,
  });
  const extractCommand = createMemoryExtractCommand({
    db: db.db,
    memoryRepository,
    configStore,
    ...(embeddingProvider !== undefined ? { embeddingProvider } : {}),
    afterWrite: (memory, ctx) => {
      // Same fire-and-forget hook chain as the main write path:
      // conflict detection + auto-embed. Both go through
      // `trackBackgroundWork` so `shutdown` drains them.
      trackBackgroundWork(
        runConflictHook(memory, { memoryRepository, conflictRepository }, hookConfig, {
          actor: ctx.actor,
          maxCandidates,
        }),
      );
      if (embeddingProvider !== undefined && configStore.get('embedding.autoEmbed')) {
        trackBackgroundWork(
          (async () => {
            try {
              const vector = await embeddingProvider.embed(memory.content);
              await memoryRepository.setEmbedding(
                memory.id,
                {
                  model: embeddingProvider.model,
                  dimension: embeddingProvider.dimension,
                  vector,
                },
                { actor: ctx.actor },
              );
            } catch {
              // Best-effort: same as the main write path.
            }
          })(),
        );
      }
    },
  });
  const conflictCommands = createConflictCommands({
    conflictRepository,
    memoryRepository,
  });
  const compactCommands = createCompactCommands({ memoryRepository, configStore });
  const configCommands = createConfigCommands({
    configRepository,
    configStore,
  });
  const embeddingCommands =
    embeddingProvider === undefined
      ? []
      : createEmbeddingCommands({
          memoryRepository,
          provider: embeddingProvider,
        });

  // `system.*` introspection commands. Always registered —
  // there is no host configuration that should suppress
  // health/scope discovery. The deps capture the path the
  // engine opened (null when adopting a handle), the package
  // version (best-effort hint from the host), whether an
  // embedder was wired, and the schema version.
  const systemCommands = createSystemCommands({
    db: db.db,
    configStore,
    embedderConfigured: embeddingProvider !== undefined,
    dbPath: dbPath ?? null,
    version: appVersion ?? 'unknown',
    schemaVersion: MEMORY_SCHEMA_VERSION,
  });

  // `pack.*` install/preview/uninstall/list (ADR-0020). The
  // resolver is built from `packs.*` config; bundled lookups
  // need an explicit version (the command/CLI scans the
  // bundled directory if needed).
  const packResolver = createDefaultPackSourceResolver({
    bundledRoot: configStore.get('packs.bundledRegistryPath'),
    allowRemoteUrls: configStore.get('packs.allowRemoteUrls'),
    urlFetchTimeoutMs: configStore.get('packs.urlFetchTimeoutMs'),
    maxPackSizeBytes: configStore.get('packs.maxPackSizeBytes'),
  });
  const packCommands = createPackCommands({
    memoryRepository,
    resolver: packResolver,
    configStore,
    // afterWrite is conflict-only here. Auto-embed for pack
    // installs is **synchronous** via `embedAndStore` below —
    // see ADR-0021. Conflict detection stays fire-and-forget
    // per ADR-0005.
    afterWrite: (memory, ctx) => {
      // Tracked so shutdown drains the hook before tearing down
      // native handles — same pattern as the main write path.
      trackBackgroundWork(
        runConflictHook(memory, { memoryRepository, conflictRepository }, hookConfig, {
          actor: ctx.actor,
          maxCandidates,
        }),
      );
    },
    // Synchronous batch-embed for fresh pack installs. Closes
    // the race that bit the 0.6.0 / 0.6.1 launches: fire-and-
    // forget auto-embed got cut off when the one-shot CLI
    // exited (or the MCP server restarted) before the async
    // embed promises resolved. By the time `pack.install`
    // returns, every fresh memory has its vector persisted.
    // Skipped when no embedder is wired or `embedding.autoEmbed`
    // is off — the caller can still recover via
    // `embedding.rebuild`.
    ...(embeddingProvider !== undefined
      ? {
          embedAndStore: async (memories, actor) => {
            if (!configStore.get('embedding.autoEmbed')) return;
            await embedAndStore(memories, embeddingProvider, memoryRepository, actor);
          },
        }
      : {}),
  });

  let builder = createRegistry();
  for (const cmd of memoryCommands) builder = builder.register(cmd);
  builder = builder.register(searchCommand);
  builder = builder.register(contextCommand);
  builder = builder.register(extractCommand);
  for (const cmd of conflictCommands) builder = builder.register(cmd);
  for (const cmd of compactCommands) builder = builder.register(cmd);
  for (const cmd of configCommands) builder = builder.register(cmd);
  for (const cmd of embeddingCommands) builder = builder.register(cmd);
  for (const cmd of systemCommands) builder = builder.register(cmd);
  for (const cmd of packCommands) builder = builder.register(cmd);
  const registry = builder.freeze();

  // Startup embedding backfill (ADR-0021). Drains memories
  // whose stored vector is missing or stale relative to the
  // configured embedder — orphans from a prior session that
  // got cut off mid-async-embed (server died, CLI exited),
  // memories from a buggy install path, or rows that were
  // written while `embedding.autoEmbed` was off and the
  // operator has since flipped it on. Bounded by
  // `embedding.startupBackfill.maxRows` so a pathological
  // backlog cannot pin boot.
  //
  // Off-thread (does not block `createMementoApp`'s return),
  // best-effort (failures swallowed and recoverable via
  // `embedding.rebuild`), single-shot per boot.
  // Tracked via `trackBackgroundWork` so `MementoApp.shutdown` can
  // drain the in-flight pass before closing the database. Without
  // it, a SIGINT during boot can tear down ONNX worker threads
  // mid-inference and abort the process with a libc++ mutex trap.
  // The closure's catch swallows errors exactly as before — the
  // backfill stays best-effort.
  if (embeddingProvider !== undefined && configStore.get('embedding.startupBackfill.enabled')) {
    const maxRows = configStore.get('embedding.startupBackfill.maxRows');
    trackBackgroundWork(
      (async () => {
        try {
          await reembedAll(memoryRepository, embeddingProvider, {
            actor: { type: 'cli' },
            batchSize: maxRows,
          });
        } catch {
          // Best-effort: see module header. The user's recovery
          // path is the explicit `embedding.rebuild` command.
        }
      })(),
    );
  }

  // Optional warmup. Drives the embedder's one-time init (heavy
  // runtime import, model load, pipeline construction) so the
  // first user-facing search does not pay the lazy-init cost.
  // Fire-and-forget — boot does not block on this. When the
  // startup backfill above is active, both promises race; the
  // backfill's first `embed()` would have triggered the same
  // init anyway, so the warmup is a no-op in that case.
  if (
    embeddingProvider !== undefined &&
    embeddingProvider.warmup !== undefined &&
    configStore.get('embedder.local.warmupOnBoot')
  ) {
    // Tracked so `shutdown` drains the warmup before tearing down
    // the embedder's native handles. This is the same race class
    // as the startup backfill: warmup loads the ONNX pipeline,
    // spinning up worker threads that must finish initialising
    // before the module destructor runs — otherwise libc++ aborts
    // on a destroyed mutex. The tracker's internal catch makes the
    // best-effort posture explicit; a failed warmup leaves the
    // next real `embed()` to surface the underlying error.
    const warmup = embeddingProvider.warmup.bind(embeddingProvider);
    trackBackgroundWork(warmup());
  }

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (ownsDatabase) {
      db.close();
    }
  };

  // Idempotent via `closed`. Drains all tracked background work
  // (post-write hooks, auto-embed, startup backfill, embedder
  // warmup) up to the configured grace window, then runs the
  // synchronous close. `Promise.race` against a timer is the right
  // primitive here: we want "complete or expire", not "abort the
  // work" — ONNX Runtime doesn't expose cancellation, and a
  // graceful drain is the only way to avoid the native-thread
  // teardown race. The snapshot is taken at the start; tasks that
  // race in *after* shutdown starts are not waited on, but by then
  // the host's HTTP/MCP transports are already closed so new tasks
  // should be vanishingly rare.
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    if (pendingBackgroundWork.size > 0) {
      const graceMs = configStore.get('embedding.startupBackfill.shutdownGraceMs');
      if (graceMs > 0) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const drain = Promise.allSettled([...pendingBackgroundWork]).then(() => {});
        const timer = new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(resolve, graceMs);
        });
        await Promise.race([drain, timer]);
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      }
    }
    close();
  };

  return {
    registry,
    db,
    configStore,
    memoryRepository,
    eventRepository,
    conflictRepository,
    configRepository,
    ...(embeddingProvider !== undefined ? { embeddingProvider } : {}),
    close,
    shutdown,
  };
}
