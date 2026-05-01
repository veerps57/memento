import { z } from 'zod';

/**
 * `OwnerRef` identifies the **principal** that owns a memory: the
 * entity whose preferences and history the memory belongs to.
 *
 * In v1, `owner` is always `{ type: 'local', id: 'self' }`. The
 * discriminated union exists so that team-scoped and agent-scoped
 * stores can be added in v2 without a migration of the type — only
 * a relaxation of the "v1 must be local/self" runtime invariant.
 *
 * The `id` field is a free-form, opaque string that is stable for the
 * lifetime of the principal:
 *
 * - `local` — always the literal string `'self'`.
 * - `team`  — a slug or stable identifier issued by the team store.
 * - `agent` — the agent's stable identifier (e.g. its public key fp).
 */
export const OwnerRefSchema = z
  .object({
    type: z.enum(['local', 'team', 'agent']).describe('Owner type. In v1, always "local".'),
    id: z.string().min(1).max(128).describe('Owner identifier. In v1, always "self".'),
  })
  .strict()
  .describe(
    'The principal that owns this memory. In single-user mode, always {"type":"local","id":"self"}.',
  );

export type OwnerRef = z.infer<typeof OwnerRefSchema>;

/**
 * `ActorRef` identifies the **agent of an action**: who or what caused
 * a `MemoryEvent` or `ConfigEvent`. It is distinct from `OwnerRef`
 * because the actor is often not the owner — for example, the MCP
 * server can record events on behalf of a `local/self` owner with
 * `actor.type === 'mcp'` and the MCP client's identifier in `agent`.
 *
 * The discriminated union mirrors the entry points into Memento:
 *
 * - `cli`       — invoked by the user via the `memento` CLI.
 * - `mcp`       — invoked by an MCP client; `agent` carries the
 *                  client's advertised name and version (e.g.
 *                  `"claude-code/0.5.0"`) for audit visibility.
 * - `scheduler` — invoked by an internal scheduled job; `job`
 *                  identifies the job (e.g. `'decay'`, `'compact'`).
 * - `system`    — invoked by the runtime itself (migrations, startup,
 *                  GC). No additional fields; the audit trail records
 *                  the event `type` for context.
 */
export const ActorRefSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('cli') })
    .strict()
    .describe('Actor is the CLI user. Example: {"type":"cli"}'),
  z
    .object({
      type: z.literal('mcp'),
      agent: z
        .string()
        .min(1)
        .max(256)
        .describe('MCP client name and version. Example: "claude-code/0.5.0"'),
    })
    .strict()
    .describe('Actor is an MCP client. Example: {"type":"mcp","agent":"claude-code/0.5.0"}'),
  z
    .object({
      type: z.literal('scheduler'),
      job: z.string().min(1).max(128).describe('Scheduled job identifier. Example: "compact"'),
    })
    .strict()
    .describe('Actor is a scheduled job. Example: {"type":"scheduler","job":"compact"}'),
  z
    .object({ type: z.literal('system') })
    .strict()
    .describe('Actor is the system itself (migrations, startup). Example: {"type":"system"}'),
]);

export type ActorRef = z.infer<typeof ActorRefSchema>;
