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
import {
  SystemInfoInputSchema,
  SystemListScopesInputSchema,
  SystemListTagsInputSchema,
} from './inputs.js';

const SURFACES = ['mcp', 'cli'] as const;
// Dashboard opt-in: the overview view uses `system.info` and the
// scope picker uses `system.list_scopes`. `system.list_tags` is
// not yet UI-wired.
const SURFACES_DASHBOARD = ['mcp', 'cli', 'dashboard'] as const;

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
    /**
     * Total number of unresolved conflicts at the moment of the
     * call. Lifted into `system.info` so the dashboard's overview
     * tile can display an accurate count instead of a paged
     * `conflict.list` response capped at `conflict.list.maxLimit`
     * — for stores with many open conflicts the paged shape was
     * always rendering the cap, masking the post-resolve
     * decrement.
     */
    openConflicts: z.number().int().nonnegative(),
    /**
     * Process-level health information mirroring the subset of
     * `memento doctor` probes that are cheap to compute on every
     * `system.info` call. `nativeBinding` is always `'ok'` here
     * because reaching the handler implies the better-sqlite3
     * .node addon loaded successfully — a structured failure
     * surfaces through `memento doctor`, never through this
     * handler.
     */
    runtime: z
      .object({
        /** `process.versions.node` — e.g. `'22.19.0'`. */
        node: z.string().min(1),
        /** `process.versions.modules` — Node's V8/N-API ABI tag. */
        modulesAbi: z.string().min(1),
        /** Always `'ok'` when this handler returns; reserved for future failure modes. */
        nativeBinding: z.literal('ok'),
      })
      .strict(),
    /**
     * Write-path scrubber state. Surfaces the resolved
     * `scrubber.enabled` config so the dashboard's system page
     * can render a "safety net active?" probe without a
     * separate `config.get` round-trip. The key is pinned at
     * server start (`mutable: false`); the boolean here just
     * mirrors the resolved value the engine is actually
     * applying to writes.
     */
    scrubber: z
      .object({
        enabled: z.boolean(),
      })
      .strict(),
    /**
     * Single-user identity surfaced to assistants. `preferredName`
     * is the value of the `user.preferredName` config; when null
     * the assistant should fall back to "The user" when authoring
     * memory content. Lifted into `system.info` (rather than
     * forcing a separate `config.get`) because it's needed on the
     * critical path of every write.
     */
    user: z
      .object({
        preferredName: z.string().nullable(),
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
    surfaces: SURFACES_DASHBOARD,
    inputSchema: SystemInfoInputSchema,
    outputSchema: SystemInfoOutputSchema,
    metadata: {
      description:
        'Server health and capability snapshot. Returns version, schema version, db path, vector retrieval status, configured embedder model + dimension, per-status memory counts, open-conflict count, runtime info (Node version, modules ABI, native-binding state), scrubber state (write-path redaction master switch), and `user.preferredName` (the name an assistant should use when authoring memory content; falls back to "The user" when null). Read-only; safe to call freely — call once at session start to learn the user\'s name and the store\'s capabilities.\n\nTip: call system.list_scopes to discover valid scopes for memory.write.',
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
        // Cheap aggregate over the conflicts table — open
        // conflicts have `resolved_at IS NULL`. Done inline here
        // (rather than through `ConflictRepository`) to keep the
        // dependency graph of system.info shallow; the count is
        // a one-row scalar and doesn't justify a new repo method.
        const openConflictsRow = await deps.db
          .selectFrom('conflicts')
          .select(deps.db.fn.countAll<number>().as('count'))
          .where('resolved_at', 'is', null)
          .executeTakeFirst();
        const openConflicts = Number(openConflictsRow?.count ?? 0);
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
          openConflicts,
          // Reaching this code path implies the better-sqlite3
          // native binding is healthy — the engine cannot have
          // started otherwise. The doctor command does the
          // verbose probe; this is the lightweight readout.
          runtime: {
            node: process.versions.node,
            modulesAbi: process.versions.modules,
            nativeBinding: 'ok' as const,
          },
          scrubber: {
            enabled: deps.configStore.get('scrubber.enabled'),
          },
          user: {
            preferredName: deps.configStore.get('user.preferredName'),
          },
        };
      }),
  };

  const listScopes: Command<
    typeof SystemListScopesInputSchema,
    typeof SystemListScopesOutputSchema
  > = {
    name: 'system.list_scopes',
    sideEffect: 'read',
    surfaces: SURFACES_DASHBOARD,
    inputSchema: SystemListScopesInputSchema,
    outputSchema: SystemListScopesOutputSchema,
    metadata: {
      description:
        'List every scope that has at least one active memory, with per-scope count and most-recent write timestamp. Sorted by count desc. Read-only; safe to call freely.\n\nCall this before writing to discover valid scopes. If the response is empty, use {"type":"global"} as a safe default scope for memory.write. The returned scope objects can be passed directly to memory.write or memory.search.',
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

  const SystemListTagsOutputSchema = z
    .object({
      tags: z.array(
        z
          .object({
            tag: z.string().min(1),
            count: z.number().int().positive(),
          })
          .strict(),
      ),
    })
    .strict();

  const listTags: Command<typeof SystemListTagsInputSchema, typeof SystemListTagsOutputSchema> = {
    name: 'system.list_tags',
    sideEffect: 'read',
    surfaces: SURFACES,
    inputSchema: SystemListTagsInputSchema,
    outputSchema: SystemListTagsOutputSchema,
    metadata: {
      description:
        'List all tags in use across memories, with per-tag counts sorted by frequency descending. Defaults to active memories only. Read-only; safe to call freely.\n\nUse this to discover valid tags before calling memory.list or memory.search with a tags filter.',
      mcpName: 'list_tags_system',
    },
    handler: async (input) =>
      runRepo('system.list_tags', async () => {
        const status = input.status ?? 'active';
        const rows = await deps.db
          .selectFrom('memories')
          .where('status', '=', status)
          .select(['tags_json'])
          .execute();
        // Explode the JSON arrays and count each tag. In-memory
        // aggregation is fine — the number of active memories in a
        // local store is small (hundreds to low thousands).
        const counts = new Map<string, number>();
        for (const row of rows) {
          const tags: string[] = JSON.parse(row.tags_json);
          for (const tag of tags) {
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
          }
        }
        const sorted = [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        return { tags: sorted };
      }),
  };

  return Object.freeze([info, listScopes, listTags]) as readonly AnyCommand[];
}
