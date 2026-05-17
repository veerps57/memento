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
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { AnyCommand, CommandContext, CommandRegistry } from '@psraghuveer/memento-core';
import { deriveMcpName, executeCommand } from '@psraghuveer/memento-core';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MEMENTO_INSTRUCTIONS } from './instructions.js';

/**
 * Implementation info reported on the MCP `initialize` handshake.
 *
 * Defaults to `@psraghuveer/memento-server` at version `0.0.0`; hosts that
 * embed the adapter (a future `npx memento serve`) override
 * these so clients see a meaningful `serverInfo`.
 *
 * `instructions` (ADR-0026) is the optional override for the
 * canonical {@link MEMENTO_INSTRUCTIONS} spine emitted on the
 * `initialize` response. Omit to ship the canonical spine
 * verbatim. Operators who want "spine + addendum" concatenate
 * `\`${MEMENTO_INSTRUCTIONS}\\n\\n${addendum}\`` and pass that
 * string; the override replaces the constant entirely rather
 * than appending, so the caller controls both halves
 * explicitly.
 */
export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
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

  const mcpCommands = registry.list().filter((cmd: AnyCommand) => cmd.surfaces.includes(SURFACE));
  const byName = new Map<string, AnyCommand>(
    mcpCommands.map((cmd: AnyCommand) => [deriveMcpName(cmd), cmd]),
  );
  const tools: readonly Tool[] = mcpCommands.map(commandToTool);

  // ADR-0026: emit the canonical session-start teaching spine on
  // every `initialize` response so clients that honour the field
  // (every spec-compliant MCP client) inject it into the
  // assistant's system prompt without the user needing to install
  // a skill or paste a persona snippet. The skill remains the
  // load-on-intent enrichment surface; the spine carries what
  // every session needs.
  const server = new Server(
    { name: info.name, version: info.version },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
        prompts: {},
      },
      instructions: info.instructions ?? MEMENTO_INSTRUCTIONS,
    },
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

  // — MCP Resources: memento://context —
  // Exposes the same data as `memory.context` as a readable
  // resource for clients that support resource subscriptions.
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: 'memento://context',
        name: 'Session Context',
        description:
          'The most relevant memories for the current session, ranked by confidence, recency, scope, and frequency.',
        mimeType: 'text/plain',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === 'memento://context' || uri.startsWith('memento://context?')) {
      const contextCommand = byName.get('get_memory_context');
      if (contextCommand === undefined) {
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: '(memory.context command not available)',
            },
          ],
        };
      }
      const result = await executeCommand(contextCommand, {}, ctx);
      if (!result.ok) {
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `Error loading context: ${result.error.message}`,
            },
          ],
        };
      }
      const output = result.value as {
        results: readonly {
          memory: { content: string | null; kind: { type: string }; tags: readonly string[] };
          score: number;
        }[];
      };
      const lines = output.results.map((r, i) => {
        const content = r.memory.content ?? '(redacted)';
        const kind = r.memory.kind.type;
        const tags = r.memory.tags.length > 0 ? ` [${r.memory.tags.join(', ')}]` : '';
        return `${i + 1}. [${kind}]${tags} ${content}`;
      });
      const text =
        lines.length > 0
          ? `Relevant memories (${lines.length}):\n\n${lines.join('\n')}`
          : 'No memories found. The store is empty or no memories match the current context.';
      return {
        contents: [{ uri, mimeType: 'text/plain', text }],
      };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // — MCP Prompts: session-context —
  // For clients that support prompts (rendered as slash commands
  // in Claude Desktop).
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: 'session-context',
        description: 'Load relevant memories for this session',
        arguments: [
          {
            name: 'focus',
            description:
              'Optional topic to focus on (triggers memory.search instead of memory.context)',
            required: false,
          },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== 'session-context') {
      throw new Error(`Unknown prompt: ${name}`);
    }

    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation
    const focus = args?.['focus'];
    if (focus !== undefined && focus !== '') {
      // Focused: run memory.search with the focus text.
      const searchCommand = byName.get('search_memory');
      if (searchCommand === undefined) {
        return {
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: '(memory.search not available)' },
            },
          ],
        };
      }
      const result = await executeCommand(searchCommand, { text: focus }, ctx);
      if (!result.ok) {
        return {
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: `Error: ${result.error.message}` },
            },
          ],
        };
      }
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Here are the relevant memories for "${focus}":\n\n${JSON.stringify(result.value, null, 2)}`,
            },
          },
        ],
      };
    }

    // No focus: run memory.context.
    const contextCommand = byName.get('get_memory_context');
    if (contextCommand === undefined) {
      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: '(memory.context not available)' },
          },
        ],
      };
    }
    const result = await executeCommand(contextCommand, {}, ctx);
    if (!result.ok) {
      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: `Error: ${result.error.message}` },
          },
        ],
      };
    }
    const output = result.value as {
      results: readonly {
        memory: { content: string | null; kind: { type: string }; tags: readonly string[] };
      }[];
    };
    const lines = output.results.map((r) => {
      const content = r.memory.content ?? '(redacted)';
      const kind = r.memory.kind.type;
      const tags = r.memory.tags.length > 0 ? ` [${r.memory.tags.join(', ')}]` : '';
      return `- [${kind}]${tags} ${content}`;
    });
    const text =
      lines.length > 0
        ? `Here are your relevant memories for this session:\n\n${lines.join('\n')}\n\nUse these to inform your responses. Call memory.confirm on any memory you actually use.`
        : 'No memories found yet. The memory store is empty.';
    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text },
        },
      ],
    };
  });

  return server;
}
