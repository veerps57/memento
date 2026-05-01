// Build the MCP `Server` instance from a populated command
// registry. Pure: no transport, no I/O. The stdio entry point
// (`./serve.ts`) wraps this with a `StdioServerTransport`; tests
// wrap it with an in-memory transport.
//
// The adapter is deliberately thin (ADR 0003): per-command
// projection here, the actual work happens in `executeCommand`.
// Surface-specific concerns owned by this file:
//
//   - filtering the registry to commands whose `surfaces`
//     includes `'mcp'`,
//   - converting the Zod input schema to a JSON Schema for
//     `tools/list`,
//   - marshalling `CallToolRequest.params.arguments` through
//     `executeCommand` and projecting the resulting `Result`
//     onto the `CallToolResult` shape (success → text content;
//     `Result.err` → `isError: true` with the structured error
//     payload preserved on `_meta` so clients can branch on
//     `code` without parsing the message).
//
// Per-command projection: tool name is `deriveMcpName(command)`
// (verb_noun snake_case per ADR-0010), description is the
// command metadata description, input schema is the Zod schema
// converted to JSON Schema. No further shape rewriting.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { AnyCommand, CommandContext, CommandRegistry } from '@psraghuveer/memento-core';
import { deriveMcpName, executeCommand } from '@psraghuveer/memento-core';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Implementation info reported on the MCP `initialize` handshake.
 *
 * Defaults to `@psraghuveer/memento-server` at version `0.0.0`; hosts that
 * embed the adapter (a future `npx memento serve`) override
 * these so clients see a meaningful `serverInfo`.
 */
export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * Inputs for `buildMementoServer`.
 *
 * `registry` is the frozen command registry; the adapter only
 * reads from it. `ctx` is the `CommandContext` handed to every
 * command handler — most importantly the `actor` that the
 * audit log records for write-side effects. Hosts pin the
 * actor at construction time; making it per-call would force
 * MCP clients to send actor identity on every request, which
 * the protocol does not model.
 */
export interface BuildMementoServerOptions {
  readonly registry: CommandRegistry;
  readonly ctx: CommandContext;
  readonly info?: ServerInfo;
}

const DEFAULT_INFO: ServerInfo = {
  name: '@psraghuveer/memento-server',
  version: '0.0.0',
};

/**
 * The MCP surface marker. Centralised so a typo in one place
 * cannot silently desync the adapter from the registry.
 */
const SURFACE = 'mcp' as const;

/**
 * Derive MCP tool annotations from the command's side-effect
 * class and any per-command overrides on `metadata.mcp`.
 *
 * Per the MCP spec, annotations are *hints* — clients use them
 * to render tool pickers ("This is a destructive action") and
 * may apply UX policy (extra confirmation) but must not make
 * security decisions on them. The mapping below is the most
 * conservative reading of the side-effect taxonomy:
 *
 *   - `read`        → readOnlyHint:true
 *   - `write`       → readOnlyHint:false, destructiveHint:false
 *   - `destructive` → readOnlyHint:false, destructiveHint:true
 *   - `admin`       → readOnlyHint:false, destructiveHint:false
 *
 * `openWorldHint` is stamped `false` for every command because
 * Memento operates against a closed local store; surfacing that
 * once here is clearer than copying the field into every
 * command's metadata.
 *
 * `idempotentHint` defaults to `false` because most write
 * commands are not idempotent (`memory.write` produces a new
 * id every call). Commands that *are* idempotent
 * (`memory.archive`, `memory.set_embedding`) opt in via
 * `metadata.mcp.idempotentHint: true`.
 *
 * Per-command `metadata.mcp` fields override the derived
 * defaults; this is the escape hatch for cases where
 * `sideEffect` alone is insufficient (e.g. a write command
 * that happens to be idempotent).
 */
function deriveAnnotations(command: AnyCommand): ToolAnnotations {
  const isRead = command.sideEffect === 'read';
  const isDestructive = command.sideEffect === 'destructive';
  const overrides = command.metadata.mcp;

  const annotations: ToolAnnotations = {
    readOnlyHint: overrides?.readOnlyHint ?? isRead,
    destructiveHint: overrides?.destructiveHint ?? isDestructive,
    idempotentHint: overrides?.idempotentHint ?? false,
    openWorldHint: false,
  };
  if (overrides?.title !== undefined) {
    return { ...annotations, title: overrides.title };
  }
  return annotations;
}

/**
 * Minimal structural shape of the JSON Schema fragments we
 * inspect when projecting a command onto an MCP tool. Pinned
 * here (rather than reused from `zod-to-json-schema`) because
 * we only care about the two fields that distinguish object
 * schemas from union schemas; everything else flows through
 * untouched.
 */
interface JsonSchemaLike {
  type?: string;
  anyOf?: readonly JsonSchemaLike[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  oneOf?: readonly JsonSchemaLike[];
  const?: unknown;
  discriminator?: { propertyName: string };
  [key: string]: unknown;
}

/**
 * Detect the discriminator property from an `anyOf` / `oneOf`
 * array. Returns the shared property name whose every branch
 * constrains it with `const`, or `undefined` if the union is
 * not a discriminated one.
 */
function detectDiscriminator(branches: readonly JsonSchemaLike[]): string | undefined {
  if (branches.length < 2) return undefined;

  // Collect candidate properties: those with `const` in the first branch.
  const first = branches[0];
  if (first?.type !== 'object' || first.properties === undefined) return undefined;

  for (const propName of Object.keys(first.properties)) {
    const prop = first.properties[propName];
    if (prop?.const === undefined) continue;

    // Check every other branch has the same property with a `const`.
    const allHaveConst = branches.every((branch) => {
      const p = branch.properties?.[propName];
      return p !== undefined && p.const !== undefined;
    });
    if (allHaveConst) return propName;
  }
  return undefined;
}

/**
 * Recursively walk a JSON Schema tree and annotate `anyOf` /
 * `oneOf` arrays that represent discriminated unions with an
 * OpenAPI 3.1-style `discriminator: { propertyName }` hint.
 *
 * Many LLM tool-calling implementations (including Claude and
 * GPT-4) recognise this annotation and use it to select the
 * correct branch without needing to trial-parse all variants.
 *
 * This mutates the schema in place for efficiency — it is
 * called on a freshly-produced `zodToJsonSchema` output that
 * is not shared.
 */
function injectDiscriminatorHints(schema: JsonSchemaLike): JsonSchemaLike {
  // Annotate top-level anyOf / oneOf.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key] as readonly JsonSchemaLike[] | undefined;
    if (Array.isArray(branches)) {
      const disc = detectDiscriminator(branches);
      if (disc !== undefined) {
        schema.discriminator = { propertyName: disc };
      }
      // Recurse into branches.
      for (const branch of branches) {
        injectDiscriminatorHints(branch);
      }
    }
  }

  // Recurse into object properties.
  if (schema.properties !== undefined) {
    for (const prop of Object.values(schema.properties)) {
      injectDiscriminatorHints(prop);
    }
  }

  // Recurse into array items.
  if (schema.items !== undefined && typeof schema.items === 'object') {
    injectDiscriminatorHints(schema.items);
  }

  return schema;
}

/**
 * Coerce the JSON Schema produced by `zodToJsonSchema` into
 * the MCP-required object-schema shape.
 *
 * MCP tool arguments are always JSON objects (`tools/call`
 * params: `{ name, arguments?: object }`). The spec therefore
 * mandates `Tool.inputSchema.type === 'object'`. The handful
 * of commands whose input is a `z.discriminatedUnion(...)` of
 * object branches convert to `{ anyOf: [...] }` with no top-
 * level `type`, and the MCP SDK rejects those at the
 * `tools/list` boundary.
 *
 * The normalisation:
 *
 *   - If the schema already has `type: 'object'`, return it
 *     unchanged. (The common case.)
 *   - If it has `anyOf` of branches that are themselves object
 *     schemas, wrap it as
 *     `{ type: 'object', oneOf: [...branches] }`. JSON Schema
 *     evaluates this as "the value is an object AND it matches
 *     exactly one of the branches", which is precisely the
 *     `discriminatedUnion` semantics.
 *   - Otherwise the command violates the contract: its input
 *     schema does not describe an object. Throw with the
 *     command name so the misconfiguration surfaces at registry
 *     wire-up time, not at the first MCP call.
 */
function normaliseToolInputSchema(raw: JsonSchemaLike, commandName: string): Tool['inputSchema'] {
  if (raw.type === 'object') {
    return raw as Tool['inputSchema'];
  }

  if (Array.isArray(raw.anyOf)) {
    const branches = raw.anyOf;
    const allObjects = branches.every((b) => b.type === 'object');
    if (allObjects) {
      const { anyOf: _anyOf, ...rest } = raw;
      return { type: 'object', ...rest, oneOf: branches } as Tool['inputSchema'];
    }
  }

  throw new Error(
    `Command '${commandName}' input schema does not describe an object value; ` +
      `MCP tools require inputSchema.type === 'object'. Got: ${JSON.stringify(raw).slice(0, 200)}`,
  );
}

/**
 * Project a single command onto the MCP `Tool` shape.
 *
 * Tool name is the command name verbatim (`'memory.search'`,
 * `'conflict.scan'`, ...). Description is the metadata
 * description, suffixed with a `(deprecated: …)` note when the
 * command carries one — clients render this directly in their
 * tool picker, so the deprecation has to be visible there.
 *
 * `annotations` carries the MCP behavioral hints (readOnly,
 * destructive, idempotent, openWorld) derived from the
 * command's side-effect class via {@link deriveAnnotations}.
 */
function commandToTool(command: AnyCommand): Tool {
  const description =
    command.metadata.deprecated === undefined
      ? command.metadata.description
      : `${command.metadata.description} (deprecated: ${command.metadata.deprecated})`;

  // `zodToJsonSchema` returns a `JsonSchema7Type`; the MCP
  // `Tool.inputSchema` field is typed as `{ type: 'object', … }`
  // with arbitrary additional fields.
  //
  // Most commands use `z.object(...).strict()` at the top level
  // and the conversion yields an object schema directly. A few
  // commands (`conflict.scan`, ...) use `z.discriminatedUnion`
  // at the top level, which converts to an `anyOf` of object
  // branches *without* a `type` field. The MCP spec requires
  // `inputSchema.type === 'object'` for every tool — clients
  // (and the MCP SDK's own `tools/list` validator) reject the
  // union shape outright.
  //
  // Both shapes describe an object value, so we wrap the union
  // in an explicit object schema preserving the branches under
  // `oneOf`. This is the canonical JSON Schema spelling of
  // "an object that matches one of these object shapes".
  const rawSchema = zodToJsonSchema(command.inputSchema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as JsonSchemaLike;
  injectDiscriminatorHints(rawSchema);
  const jsonSchema = normaliseToolInputSchema(rawSchema, command.name);

  return {
    name: deriveMcpName(command),
    description,
    inputSchema: jsonSchema,
    annotations: deriveAnnotations(command),
  };
}

/**
 * Build a `CallToolResult` for a command outcome.
 *
 * MCP expresses tool errors as a `content` payload with
 * `isError: true`, not as a JSON-RPC error — JSON-RPC errors
 * are reserved for protocol-level failures (unknown method,
 * malformed message). User / I/O failures are tool results.
 *
 * The structured `MementoError` is preserved on `_meta.error`
 * so well-behaved clients can branch on `code` without
 * parsing `message`. Less capable clients still see a useful
 * human-readable `text` body.
 */
function successResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError: false,
  };
}

function errorResult(error: {
  code: string;
  message: string;
  details?: unknown;
}): CallToolResult {
  return {
    content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
    isError: true,
    _meta: { error },
  };
}

/**
 * Wire a populated command registry up to a fresh MCP `Server`.
 *
 * The returned `Server` is unconnected; the caller attaches a
 * transport (`StdioServerTransport`, `InMemoryTransport`, ...).
 * That separation keeps the adapter testable without going
 * through stdio, and lets future hosts pick a different
 * transport without touching this file.
 */
export function buildMementoServer(options: BuildMementoServerOptions): Server {
  const { registry, ctx, info = DEFAULT_INFO } = options;

  const mcpCommands = registry.list().filter((cmd) => cmd.surfaces.includes(SURFACE));
  const byName = new Map<string, AnyCommand>(mcpCommands.map((cmd) => [deriveMcpName(cmd), cmd]));
  const tools: readonly Tool[] = mcpCommands.map(commandToTool);

  const server = new Server(
    { name: info.name, version: info.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawInput } = request.params;
    const command = byName.get(name);
    if (command === undefined) {
      // Unknown tools are returned as in-band errors rather than
      // JSON-RPC errors: the registry is the source of truth, and
      // a missing tool is a caller mistake (typo, version skew),
      // not a transport-level failure.
      return errorResult({
        code: 'INVALID_INPUT',
        message: `Unknown tool '${name}'`,
      });
    }

    const result = await executeCommand(command, rawInput, ctx);
    if (!result.ok) {
      return errorResult(result.error);
    }
    return successResult(result.value);
  });

  return server;
}
