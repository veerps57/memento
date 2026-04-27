// `system.*` command set — read-only introspection for assistants.
//
// Why this exists
// ---------------
// MCP-capable AI assistants need a cheap, in-protocol way to
// answer "is this server alive, what version, what's enabled?"
// without dropping out to a terminal to run `memento doctor`.
// `doctor` stays a CLI-only command because it does host-level
// probes (filesystem, peer-package resolution, lock files) that
// the registry layer should not know about. `system.info` is
// the in-app slice of that picture: anything that can be
// answered from the open database, the config store, and the
// already-injected dependencies.
//
// Side-effect class is `read` for both commands — they never
// write a `MemoryEvent` or `ConfigEvent`. Surfaces are `mcp`
// + `cli` so a human operator can grep the same JSON the
// assistant sees.

import { type Result, ScopeSchema, TimestampSchema, ok } from '@psraghuveer/memento-schema';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ConfigStore } from '../../config/index.js';
import type { MementoSchema } from '../../storage/schema.js';
import { repoErrorToMementoError } from '../errors.js';
import type { AnyCommand, Command } from '../types.js';
import { SystemInfoInputSchema, SystemListScopesInputSchema } from './inputs.js';

const SURFACES = ['mcp', 'cli'] as const;

/**
 * Output schema for `system.info`. Designed to be safe to grow
 * over time — every nested object is open-shaped via additive
 * fields. Clients should pattern-match on `version` /
 * `schemaVersion` rather than deep-equality.
 */
const SystemInfoOutputSchema = z
  .object({
    /**
     * Memento package version. Threaded through from the
     * bootstrap caller (CLI/server reads its own
     * `package.json`); when the host did not supply one, this
     * is `'unknown'`. Treated as a hint, not a contract.
     */
    version: z.string().min(1),
    /**
     * `MEMORY_SCHEMA_VERSION` — bumped only by intentional
     * shape changes to the `Memory` row. Useful for clients
     * that cache parsed memories across sessions.
     */
    schemaVersion: z.number().int().nonnegative(),
    /**
     * The on-disk database path the engine opened, or `null`
     * when the host adopted a pre-opened handle (tests, custom
     * embeds). Diagnostic only — clients should not parse it.
     */
    dbPath: z.string().nullable(),
    /**
     * Resolved `retrieval.vector.enabled`. Read at call time so
     * the answer reflects the current config layer, not the
     * snapshot at app open.
     */
    vectorEnabled: z.boolean(),
    embedder: z
      .object({
        /**
         * `true` iff the host wired an `EmbeddingProvider` into
         * `createMementoApp`. When `false`, vector search will
         * fail with `CONFIG_ERROR` regardless of
         * `vectorEnabled`.
         */
        configured: z.boolean(),
        /** Resolved `embedder.local.model` config value. */
        model: z.string().min(1),
        /** Resolved `embedder.local.dimension` config value. */
        dimension: z.number().int().positive(),
      })
      .strict(),
    counts: z
      .object({
        active: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative(),
        forgotten: z.number().int().nonnegative(),
        superseded: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const SystemListScopesOutputSchema = z
  .object({
    scopes: z.array(
      z
        .object({
          scope: ScopeSchema,
          /** Active-status memory count for this scope. */
          count: z.number().int().nonnegative(),
          /** ISO-8601 timestamp of the most recent active write, or null when empty. */
          lastWriteAt: TimestampSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export interface CreateSystemCommandsDeps {
  /** Kysely handle. Read-only queries against `memories`. */
  readonly db: Kysely<MementoSchema>;
  /** Used to read live config keys at call time. */
  readonly configStore: ConfigStore;
  /**
   * Whether the host wired an `EmbeddingProvider`. We pass the
   * boolean rather than the provider itself because the only
   * useful field for `system.info` is presence — anything more
   * detailed lives on the provider's own surfaces.
   */
  readonly embedderConfigured: boolean;
  /**
   * Path the engine opened. `null` when the host adopted a
   * pre-opened database (tests, embedded use).
   */
  readonly dbPath: string | null;
  /**
   * Memento package version. The CLI/server resolve this from
   * their own `package.json`; tests typically pass a stub.
   */
  readonly version: string;
  /**
   * Frozen `MEMORY_SCHEMA_VERSION` value. Threaded as a dep
   * (rather than imported here) so a future split between
   * memory and event schema versions doesn't require touching
   * this command — additive on the deps shape only.
   */
  readonly schemaVersion: number;
}

async function runRepo<T>(op: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return { ok: false, error: repoErrorToMementoError(error, op) };
  }
}

export function createSystemCommands(deps: CreateSystemCommandsDeps): readonly AnyCommand[] {
  const info: Command<typeof SystemInfoInputSchema, typeof SystemInfoOutputSchema> = {
    name: 'system.info',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: SystemInfoInputSchema,
    outputSchema: SystemInfoOutputSchema,
    metadata: {
      description:
        'Server health and capability snapshot. Returns version, schema version, db path, vector retrieval status, configured embedder model + dimension, and per-status memory counts. Read-only; safe to call freely.',
    },
    handler: async () =>
      runRepo('system.info', async () => {
        const rows = await deps.db
          .selectFrom('memories')
          .select(['status', deps.db.fn.countAll<number>().as('count')])
          .groupBy('status')
          .execute();
        const counts = { active: 0, archived: 0, forgotten: 0, superseded: 0 };
        for (const row of rows) {
          // Coerce: better-sqlite3 returns COUNT(*) as bigint
          // when the value exceeds Number.MAX_SAFE_INTEGER. In
          // practice store sizes are tiny; Number() is safe.
          const n = Number(row.count);
          // status is a closed union from the table type.
          counts[row.status as keyof typeof counts] = n;
        }
        return {
          version: deps.version,
          schemaVersion: deps.schemaVersion,
          dbPath: deps.dbPath,
          vectorEnabled: deps.configStore.get('retrieval.vector.enabled'),
          embedder: {
            configured: deps.embedderConfigured,
            model: deps.configStore.get('embedder.local.model'),
            dimension: deps.configStore.get('embedder.local.dimension'),
          },
          counts,
        };
      }),
  };

  const listScopes: Command<
    typeof SystemListScopesInputSchema,
    typeof SystemListScopesOutputSchema
  > = {
    name: 'system.list_scopes',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: SystemListScopesInputSchema,
    outputSchema: SystemListScopesOutputSchema,
    metadata: {
      description:
        'List every scope that has at least one active memory, with per-scope count and most-recent write timestamp. Sorted by count desc. Read-only; safe to call freely. Useful for an assistant that needs to discover which scopes the user has populated before issuing scoped reads.',
    },
    handler: async () =>
      runRepo('system.list_scopes', async () => {
        const rows = await deps.db
          .selectFrom('memories')
          .where('status', '=', 'active')
          .select([
            'scope_json',
            deps.db.fn.countAll<number>().as('count'),
            deps.db.fn.max('created_at').as('last_write_at'),
          ])
          .groupBy('scope_json')
          .orderBy('count', 'desc')
          .orderBy('last_write_at', 'desc')
          .execute();
        const scopes = rows.map((row) => ({
          // `scope_json` is the canonical source of truth (the
          // repository serialises through `JSON.stringify` on a
          // sorted-keys form). Re-validating with `ScopeSchema`
          // both narrows the parse and protects against any
          // hand-edited row drift.
          scope: ScopeSchema.parse(JSON.parse(row.scope_json)),
          count: Number(row.count),
          lastWriteAt: row.last_write_at === null ? null : TimestampSchema.parse(row.last_write_at),
        }));
        return { scopes };
      }),
  };

  return Object.freeze([info, listScopes]) as readonly AnyCommand[];
}
