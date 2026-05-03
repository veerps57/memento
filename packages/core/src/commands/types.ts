// Command registry types.
//
// Per ADR 0003, every operation Memento exposes is defined exactly
// once as a `Command` — a typed handler with Zod input/output
// schemas and metadata. `@psraghuveer/memento-server` (MCP) and `@psraghuveer/memento-cli`
// are thin adapters that project the registry; a contract test
// asserts every registered command is exposed by both adapters.
//
// The shape here is deliberately minimal:
//
// - `name` is a stable dotted identifier (e.g. `'memory.write'`)
//   that doubles as the MCP tool name and CLI subcommand path.
//   It's the only contract callers can rely on; renames go
//   through a deprecation cycle.
// - `inputSchema` / `outputSchema` are Zod schemas. The adapters
//   parse on the way in and validate on the way out; in-process
//   callers (tests, the CLI bound directly) get the same
//   guarantees by going through `executeCommand`.
// - `sideEffect` is a closed enum so adapters can decide things
//   like "require --confirm for destructive ops" or "tag a span
//   with the right OTel attribute" structurally.
// - `surfaces` enumerates the adapters allowed to expose this
//   command. v1 only has `'mcp' | 'cli'`; the literal list keeps
//   the contract test honest if someone adds a third surface.
// - `handler` is the only place the command actually does work.
//   It receives the parsed input and a `CommandContext` and
//   returns a `Result<Output>`. Throws are reserved for
//   programmer errors (invariant breaches); user / I/O errors
//   are values per the schema-side contract.

import type { ActorRef, Result } from '@psraghuveer/memento-schema';
import type { z } from 'zod';

/**
 * Side-effect class, surfaced to adapters so they can apply
 * surface-appropriate policy without re-deriving it from the
 * command name.
 *
 * - `read`        — pure read; safe to call freely.
 * - `write`       — mutates state; produces a memory or config
 *                   event. The adapter may log, audit, or
 *                   require confirmation as configured.
 * - `destructive` — bulk or irreversible operation (forget en
 *                   masse, archive, reset). Adapters require
 *                   explicit confirmation and apply dry-run
 *                   defaults where it makes sense.
 * - `admin`       — operational / introspection command
 *                   (doctor, compact, reembed). Not data-plane;
 *                   typically scheduler- or operator-invoked.
 */
export type CommandSideEffect = 'read' | 'write' | 'destructive' | 'admin';

/**
 * Surface allow-list. The MCP server, the CLI, and the
 * dashboard's HTTP `/api/commands` endpoint each consume a
 * subset of the registry. Adapters filter by `surfaces` on the
 * way out: the dashboard rejects any command that does not
 * include `'dashboard'` with a clear `INVALID_INPUT` pointing
 * the caller at the CLI alternative. New commands are
 * mcp+cli-only by default; opting them onto the dashboard is an
 * explicit decision with a one-line review surface in the
 * registration site.
 */
export type CommandSurface = 'mcp' | 'cli' | 'dashboard';

/**
 * The execution context handed to every command handler.
 *
 * `actor` is mandatory because every state-changing operation
 * must record one in the audit log. Read-only commands receive
 * it too — uniformity simplifies the adapter glue and makes
 * future per-actor authorisation a non-breaking change.
 */
export interface CommandContext {
  readonly actor: ActorRef;
}

/**
 * MCP tool annotation hints. Mirrors the protocol's
 * `ToolAnnotations` shape (see modelcontextprotocol/sdk
 * `ToolAnnotationsSchema`) but is owned by core so the command
 * package does not pull the SDK as a dependency.
 *
 * All fields are advisory — they are projected onto the tool's
 * `annotations` block at adapter build time and rendered by
 * compliant clients in their tool picker. Per the MCP spec they
 * are *hints*: clients must not make security decisions based on
 * them. The server adapter derives sensible defaults from the
 * command's `sideEffect` (read → readOnlyHint:true, etc.); these
 * fields override per-command when the default would be wrong
 * (e.g. `memory.archive` is destructive but idempotent).
 *
 * `openWorldHint` is omitted in our shape because every Memento
 * command operates against a closed local store; the adapter
 * stamps `openWorldHint: false` unconditionally rather than
 * making each command restate it.
 */
export interface McpHints {
  /** Short display title; falls back to the command name in clients that show one. */
  readonly title?: string;
  /** Override the readOnlyHint default derived from `sideEffect`. */
  readonly readOnlyHint?: boolean;
  /** Override the destructiveHint default derived from `sideEffect`. */
  readonly destructiveHint?: boolean;
  /** Set when calling repeatedly with the same arguments has no further effect. */
  readonly idempotentHint?: boolean;
}

/**
 * Optional adapter-facing metadata. Used by docs generation and
 * the CLI/MCP adapters to render usage strings without parsing
 * the schema. None of these fields affect runtime semantics.
 */
export interface CommandMetadata {
  /** Human-readable one-line summary (rendered as the MCP tool description and CLI subcommand summary). */
  readonly description: string;
  /** Optional longer explanation; used by `memento help <command>` and the generated reference. */
  readonly longDescription?: string;
  /** Stable since-version tag for the command. Empty string means "since v1". */
  readonly since?: string;
  /** Marks a command as deprecated; the value is the rationale + replacement. */
  readonly deprecated?: string;
  /**
   * MCP tool name override (ADR-0010). When omitted, the MCP
   * adapter derives `${verb}_${noun}` from the dotted command
   * name (e.g. `memory.read` → `read_memory`). Set this when
   * the default reads awkwardly — collection-style commands
   * usually want a pluralised noun (`memory.list` →
   * `list_memories`) and event/history feeds want an explicit
   * `list_` prefix (`memory.events` → `list_memory_events`).
   *
   * The CLI ignores this field; CLI subcommand paths are
   * always derived from the dotted name.
   */
  readonly mcpName?: string;
  /** Optional MCP tool-annotation overrides; defaults are derived from `sideEffect`. */
  readonly mcp?: McpHints;
}

/**
 * A single registered command. Generic over its input and output
 * Zod types so that handler bodies and adapter projections see
 * the precise inferred TypeScript shapes.
 *
 * Adapters never invoke `handler` directly. They call
 * `executeCommand(command, rawInput, ctx)` from `./execute.ts`,
 * which parses the input, runs the handler, and parses the
 * output. That keeps the validation contract in one place rather
 * than each adapter re-implementing it.
 */
export interface Command<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  readonly name: string;
  readonly sideEffect: CommandSideEffect;
  readonly surfaces: readonly CommandSurface[];
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly metadata: CommandMetadata;
  readonly handler: (input: z.infer<I>, ctx: CommandContext) => Promise<Result<z.infer<O>>>;
}

/**
 * `AnyCommand` erases the input/output generics so the registry
 * can hold a heterogeneous set. Adapters iterate over
 * `AnyCommand`s; handler invocation happens through
 * `executeCommand`, which restores the type information at the
 * call site.
 */
// biome-ignore lint/suspicious/noExplicitAny: registry is heterogeneous by design
export type AnyCommand = Command<any, any>;
