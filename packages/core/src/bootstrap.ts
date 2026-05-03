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
  createRegistry,
  createSystemCommands,
} from './commands/index.js';
import type { CommandRegistry } from './commands/index.js';
import type { ConfigOverrides, ConfigRepository, ConfigStore } from './config/index.js';
import { createConfigRepository, createMutableConfigStore } from './config/index.js';
import type { ConflictHookConfig, ConflictRepository } from './conflict/index.js';
import { createConflictRepository, runConflictHook } from './conflict/index.js';
import type { EmbeddingProvider } from './embedding/index.js';
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
  /** Idempotent. Closes the database iff this app opened it. */
  close(): void;
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

  const memoryCommands = createMemoryCommands(
    memoryRepository,
    {
      afterWrite: (memory, ctx) => {
        // Fire-and-forget per ADR-0005. `runConflictHook` is
        // non-throwing — every failure mode is folded into its
        // returned outcome — so the `void` is safe; observability
        // for the outcome lands when the logging layer does.
        void runConflictHook(memory, { memoryRepository, conflictRepository }, hookConfig, {
          actor: ctx.actor,
          maxCandidates,
        });
        // Auto-embed: fire-and-forget, same pattern as conflict hook.
        // Guarded by provider presence + config flag. Errors are
        // swallowed — embedding is best-effort; the memory is already
        // persisted. The user can always run `embedding rebuild` later.
        if (embeddingProvider !== undefined && configStore.get('embedding.autoEmbed')) {
          void (async () => {
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
          })();
        }
      },
    },
    { eventRepository, configStore },
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
      // conflict detection + auto-embed.
      void runConflictHook(memory, { memoryRepository, conflictRepository }, hookConfig, {
        actor: ctx.actor,
        maxCandidates,
      });
      if (embeddingProvider !== undefined && configStore.get('embedding.autoEmbed')) {
        void (async () => {
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
        })();
      }
    },
  });
  const conflictCommands = createConflictCommands({
    conflictRepository,
    memoryRepository,
  });
  const compactCommands = createCompactCommands({ memoryRepository });
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
  const registry = builder.freeze();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (ownsDatabase) {
      db.close();
    }
  };

  return {
    registry,
    db,
    configStore,
    memoryRepository,
    eventRepository,
    conflictRepository,
    configRepository,
    close,
  };
}
