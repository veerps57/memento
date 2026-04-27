// MCP client snippet registry for `memento init`.
//
// Why a registry, not a switch
// ----------------------------
//
// Each MCP client picks a slightly different config-file path
// and JSON shape. Encoding them in a typed registry — one
// `ClientSnippetSpec` per client, keyed by id — keeps the
// addition of a new client to a single struct, and lets the
// renderer iterate without growing branches. Matches the same
// "config-driven, extensible" stance the rest of the CLI uses
// (`LIFECYCLE_COMMANDS`, `CONFIG_KEY_NAMES`).
//
// What lives here
// ---------------
//
//   - The set of clients we support out of the box: Claude
//     Code, Cursor, VS Code, OpenCode.
//   - A pure renderer that, given a `dbPath`, returns the
//     pretty-printed JSON snippet a user should paste into the
//     client's config file.
//
// What does NOT live here
// -----------------------
//
//   - Filesystem writes. `init` is print-only by design — see
//     ADR-style discussion in `init.ts`'s header.
//   - TTY / format / colour decisions. Those belong to the
//     caller (`init.ts` and the dispatcher).

/** Discriminator for a supported MCP client. */
export type InitClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'opencode';

/** Stable contract returned to callers of `memento init`. */
export interface ClientSnippet {
  readonly id: InitClientId;
  readonly displayName: string;
  /**
   * Human-friendly hint at where the snippet should be pasted.
   * May contain `~` (we don't expand it — different clients
   * reference different home dirs in their docs) or a relative
   * path for project-scoped configs (e.g. VS Code workspace).
   */
  readonly configPath: string;
  /** Pretty-printed JSON, ending in `\n`. Ready to paste. */
  readonly snippet: string;
  /**
   * Optional one-line install hint (e.g. `claude mcp add ...`)
   * for clients that prefer a CLI subcommand over file edits.
   */
  readonly installHint?: string;
}

/**
 * Per-client renderer. Pure: input is the resolved DB path,
 * output is the snippet the user should paste. The DB path is
 * embedded in `env.MEMENTO_DB` so the snippet is self-contained
 * — the spawned `memento serve` process picks up the right
 * database without the user editing two places.
 */
interface ClientSnippetSpec {
  readonly id: InitClientId;
  readonly displayName: string;
  readonly configPath: string;
  /**
   * Optional install hint shown alongside the snippet. For
   * clients that ship a first-class subcommand for adding MCP
   * servers (Claude Code's `claude mcp add`), recommending the
   * subcommand sidesteps the file-format question entirely.
   */
  readonly installHint?: string;
  readonly render: (dbPath: string, name: string) => string;
}

// We intentionally invoke memento via `npx -y @psraghuveer/memento`
// in every snippet. Reasons:
//
//   - Works whether or not the user has `memento` on PATH.
//   - Pins the package name (clients that share an installation
//     can pick up newer versions via npx's cache).
//   - Avoids us having to resolve the absolute path of the CLI
//     binary at init-time (which is ambiguous when init was
//     itself launched via npx).
//
// Users who installed globally can swap `["npx", "-y",
// "@psraghuveer/memento", "serve"]` for `["memento", "serve"]`
// (or `command: "memento", args: ["serve"]` in the
// command/args-shaped clients). The init renderer surfaces this
// tip in its text output.
const SERVE_COMMAND = 'npx';
const SERVE_ARGS = ['-y', '@psraghuveer/memento', 'serve'] as const;

/**
 * Claude Code persists user-scope MCP servers in `~/.claude.json`
 * under the `mcpServers` key (project-scope is `.mcp.json` in
 * the repo root). The recommended UX is the `claude mcp add`
 * subcommand; the JSON snippet below is the equivalent merge
 * for users who prefer to edit the file directly.
 *
 * Shape:
 *   {
 *     "mcpServers": {
 *       "<name>": { "command": "...", "args": [...], "env": {...} }
 *     }
 *   }
 */
function renderClaudeCode(dbPath: string, name: string): string {
  return prettyJson({
    mcpServers: {
      [name]: {
        command: SERVE_COMMAND,
        args: [...SERVE_ARGS],
        env: { MEMENTO_DB: dbPath },
      },
    },
  });
}

/**
 * Claude Desktop reads `claude_desktop_config.json` at a
 * platform-specific path. The shape is identical to Claude Code
 * (`mcpServers`), so the snippet body is the same; only the
 * config path differs.
 */
function renderClaudeDesktop(dbPath: string, name: string): string {
  return prettyJson({
    mcpServers: {
      [name]: {
        command: SERVE_COMMAND,
        args: [...SERVE_ARGS],
        env: { MEMENTO_DB: dbPath },
      },
    },
  });
}

/**
 * Cursor uses the same `mcpServers` envelope as Claude, but
 * stored at `~/.cursor/mcp.json` (or workspace-scoped under
 * `.cursor/mcp.json`).
 */
function renderCursor(dbPath: string, name: string): string {
  return prettyJson({
    mcpServers: {
      [name]: {
        command: SERVE_COMMAND,
        args: [...SERVE_ARGS],
        env: { MEMENTO_DB: dbPath },
      },
    },
  });
}

/**
 * VS Code Agent mode uses `servers` (not `mcpServers`), with an
 * explicit `type` discriminator. Workspace-scoped at
 * `.vscode/mcp.json`; user-scoped at the equivalent in user
 * settings.
 */
function renderVSCode(dbPath: string, name: string): string {
  return prettyJson({
    servers: {
      [name]: {
        type: 'stdio',
        command: SERVE_COMMAND,
        args: [...SERVE_ARGS],
        env: { MEMENTO_DB: dbPath },
      },
    },
  });
}

/**
 * OpenCode (https://opencode.ai/docs/mcp-servers) uses an
 * `mcp` object whose entries carry `type: "local"`, with the
 * command split into a single `command` array (no separate
 * `args`) and `environment` (not `env`). Schema URL is included
 * so editors lint it.
 */
function renderOpenCode(dbPath: string, name: string): string {
  return prettyJson({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      [name]: {
        type: 'local',
        command: [SERVE_COMMAND, ...SERVE_ARGS],
        enabled: true,
        environment: { MEMENTO_DB: dbPath },
      },
    },
  });
}

const CLIENT_SPECS: readonly ClientSnippetSpec[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    configPath: '~/.claude.json (user scope) or .mcp.json (project scope)',
    installHint:
      'Recommended: `claude mcp add memento -e MEMENTO_DB=<path> -- npx -y @psraghuveer/memento serve`',
    render: renderClaudeCode,
  },
  {
    id: 'claude-desktop',
    displayName: 'Claude Desktop',
    configPath:
      '~/Library/Application Support/Claude/claude_desktop_config.json (macOS) | %APPDATA%/Claude/claude_desktop_config.json (Windows) | ~/.config/Claude/claude_desktop_config.json (Linux)',
    render: renderClaudeDesktop,
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    configPath: '~/.cursor/mcp.json',
    render: renderCursor,
  },
  {
    id: 'vscode',
    displayName: 'VS Code',
    configPath: '.vscode/mcp.json (workspace) or user `mcp.json` (user scope)',
    render: renderVSCode,
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    configPath: '~/.config/opencode/opencode.json',
    render: renderOpenCode,
  },
];

/** Stable list of supported client ids. */
export const INIT_CLIENT_IDS: readonly InitClientId[] = CLIENT_SPECS.map((s) => s.id);

/**
 * Options for rendering snippets.
 *
 * - `clients` filters to a subset of supported ids (used by
 *   `memento init --client cursor,vscode`).
 * - `name` overrides the server key embedded in every snippet
 *   (used by `memento init --name foo` for users who already
 *   have a `memento` server registered with a different
 *   purpose).
 */
export interface RenderClientSnippetsOptions {
  readonly clients?: readonly InitClientId[];
  readonly name?: string;
}

const DEFAULT_NAME = 'memento';

/**
 * Render snippets for the requested set of clients. Pure;
 * order is the registration order in `CLIENT_SPECS`. Unknown
 * ids are dropped silently — callers should validate input
 * against `INIT_CLIENT_IDS` before calling.
 */
export function renderClientSnippets(
  dbPath: string,
  options: RenderClientSnippetsOptions = {},
): readonly ClientSnippet[] {
  const wanted = options.clients;
  const name = options.name ?? DEFAULT_NAME;
  const specs =
    wanted === undefined ? CLIENT_SPECS : CLIENT_SPECS.filter((s) => wanted.includes(s.id));
  return specs.map((spec) => ({
    id: spec.id,
    displayName: spec.displayName,
    configPath: spec.configPath,
    snippet: spec.render(dbPath, name),
    ...(spec.installHint !== undefined ? { installHint: spec.installHint } : {}),
  }));
}

/**
 * Type-guard for caller-supplied client ids. Used by `init.ts`
 * to validate `--client foo,bar` before passing through to the
 * renderer.
 */
export function isInitClientId(value: string): value is InitClientId {
  return INIT_CLIENT_IDS.includes(value as InitClientId);
}

/**
 * Pretty-print JSON the way humans expect to see config files:
 * 2-space indent, trailing newline.
 */
function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
