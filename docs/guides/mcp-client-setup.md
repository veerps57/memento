# Wiring Memento into an MCP client

Memento ships as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Any MCP-aware client — Claude Desktop, Claude Code, Cursor, Cline, Aider, OpenCode, VS Code's Agent mode, and so on — can talk to it the same way: by spawning the `memento serve` process and exchanging JSON-RPC over stdin/stdout.

This guide is written for both human operators and AI agents. The configuration snippets are concrete and copy-paste ready; the "why" notes are short and one click away from the supporting docs.

## Quickstart: `memento init`

The fastest path is to let Memento generate every snippet for you, with the resolved database path already filled in:

```bash
# pick a stable database location once
export MEMENTO_DB=~/.local/share/memento/memento.db
mkdir -p "$(dirname "$MEMENTO_DB")"

# create the database, run migrations, print client snippets
npx @psraghuveer/memento init
```

`memento init` is idempotent — running it again is safe and just reprints the snippets. It supports Claude Code, Claude Desktop, Cursor, VS Code Agent mode, and OpenCode out of the box. To target a subset, pass `--client` (csv): `memento init --client claude-code,opencode`.

For the full per-client walkthrough (Cline, custom paths, troubleshooting), keep reading.

## Prerequisites

Install Memento. Either path works — pick the one that matches how your MCP client spawns servers:

**Option A — global install** (recommended for client configs that take a bare command name):

```bash
npm install -g @psraghuveer/memento
memento doctor          # confirms install + database writability
```

This puts `memento` on your `$PATH`. Client config can then use `"command": "memento"`.

**Option B — `npx`** (no global state, fetched on demand):

```bash
npx @psraghuveer/memento doctor
```

Client config uses `"command": "npx"` with `"args": ["@psraghuveer/memento", "serve"]`. The first run downloads and caches the package; subsequent runs reuse the cache.

**Option C — from a clone** (contributors only). Build the workspace and point clients at `node /abs/path/to/packages/cli/dist/cli.js`. See [`README.md`](../../README.md#getting-started) for the workspace setup.

The snippets below default to Option A. To switch to npx, replace `"command": "memento", "args": ["serve"]` with `"command": "npx", "args": ["@psraghuveer/memento", "serve"]`.

## What every client needs

Memento's MCP transport is stdio only. Every client config boils down to four pieces of information:

1. A **command** to spawn (`memento` if globally installed, or `npx` with `@psraghuveer/memento` as the first arg).
2. The **arguments** to pass it (`serve`, plus optional flags).
3. Optional **environment variables** — most importantly `MEMENTO_DB`, the absolute path to the SQLite file Memento should use. When unset, Memento defaults to the XDG data dir (`$XDG_DATA_HOME/memento/memento.db`, typically `~/.local/share/memento/memento.db` on POSIX and `%LOCALAPPDATA%\memento\memento.db` on Windows), so MCP-launched servers find the same store regardless of cwd. Set `MEMENTO_DB` explicitly when you want a different location.
4. Optional **CLI flags** after `serve` — `--db /abs/path/to/memento.db` is equivalent to `MEMENTO_DB`. Use whichever fits the client's config shape better.

Pick a stable absolute path for the database before you start. A reasonable default on macOS / Linux:

```bash
mkdir -p ~/.local/share/memento
echo ~/.local/share/memento/memento.db
```

On Windows, `%LOCALAPPDATA%\memento\memento.db` is the equivalent.

## Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add `memento` under the top-level `mcpServers` map:

```json
{
  "mcpServers": {
    "memento": {
      "command": "memento",
      "args": ["serve"],
      "env": {
        "MEMENTO_DB": "/Users/<you>/.local/share/memento/memento.db"
      }
    }
  }
}
```

Save the file and fully quit Claude Desktop (the menu-bar icon, not just the window). Reopen it. The first time you ask Claude something memory-related, it should call one of Memento's MCP tools — you can confirm by inspecting the tool-call inspector.

## Claude Code (CLI)

Claude Code stores MCP servers in `~/.claude.json` for user scope or a workspace `.mcp.json` for project scope. The supported way to register Memento is the built-in subcommand:

```bash
claude mcp add memento -e MEMENTO_DB=~/.local/share/memento/memento.db -- npx -y @psraghuveer/memento serve
```

Drop `-e MEMENTO_DB=...` if you've already exported `MEMENTO_DB`. To register at project scope (a `.mcp.json` checked into the repo) add `--scope project`. To inspect or remove the entry use `claude mcp list` and `claude mcp remove memento`.

If you'd rather edit the file directly, the JSON shape is identical to Claude Desktop above — add a `memento` entry under `mcpServers` in `~/.claude.json` (user scope) or `.mcp.json` (project scope).

## Cursor

Cursor exposes MCP servers under **Settings → Cursor Settings → MCP → Add new MCP server**. Cursor writes the resulting config to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memento": {
      "command": "memento",
      "args": ["serve"],
      "env": {
        "MEMENTO_DB": "/Users/<you>/.local/share/memento/memento.db"
      }
    }
  }
}
```

After saving, restart Cursor. The MCP panel should list `memento` as connected; tool calls from chat will now route through it.

## Cline (VS Code extension)

Open the Cline panel in VS Code, click the **MCP Servers** icon, and choose **Edit MCP settings**. Cline stores the result in `~/.config/Cline/mcp_servers.json` (Linux/macOS) or `%APPDATA%\Cline\mcp_servers.json` (Windows). The `memento` entry is the same JSON object as above.

## VS Code Agent mode

VS Code's Agent mode reads MCP servers from `.vscode/mcp.json` in the workspace root or from the user-level equivalent. Use the workspace file for project-scoped memory and the user file for global memory:

```json
// .vscode/mcp.json
{
  "servers": {
    "memento": {
      "command": "memento",
      "args": ["serve"],
      "env": {
        "MEMENTO_DB": "${workspaceFolder}/.memento/memento.db"
      }
    }
  }
}
```

`${workspaceFolder}` keeps the path relative to the project, which is appropriate when the database itself is project-scoped (`.gitignore` already excludes `memento.db` and the `.memento/` directory).

## OpenCode

OpenCode reads `~/.config/opencode/opencode.json`. Add `memento` under the `mcp` map. OpenCode accepts both an array form (`command: ["memento", "serve"]`) and a split `command` + `args` form; if `memento init` produced a snippet for a different client and you want to adapt it, the array form is usually what OpenCode expects:

```json
{
  "mcp": {
    "memento": {
      "type": "local",
      "command": ["memento", "serve"],
      "environment": {
        "MEMENTO_DB": "/Users/<you>/.local/share/memento/memento.db"
      }
    }
  }
}
```

Restart OpenCode after editing. If the server doesn't connect, run `memento doctor --mcp` — it scans the OpenCode config among other client configs and flags shape mismatches.

## A note on databases and scope

Memento stores **every** memory in a single SQLite file. Scope is a row-level property on each memory, not a database-selection rule. That means:

- Pointing different clients at the same `MEMENTO_DB` is the supported way to share memory across tools.
- Pointing them at different files gives you isolated stores, useful for testing or for keeping experimental memory out of your main store.
- The `--db` flag and `MEMENTO_DB` environment variable are equivalent; precedence is `--db` > `MEMENTO_DB` > XDG default (`$XDG_DATA_HOME/memento/memento.db`, e.g. `~/.local/share/memento/memento.db`).

For the full scope model, see [`docs/architecture/scope-semantics.md`](../architecture/scope-semantics.md).

## Verifying the wiring

Once a client is configured, the fastest way to confirm Memento is reachable is to watch the SQLite file: any successful tool call writes an audit event, and the file's modification time will bump.

```bash
stat -f "%Sm" /Users/<you>/.local/share/memento/memento.db   # macOS
stat -c "%y" /Users/<you>/.local/share/memento/memento.db    # Linux
```

If the timestamp does not change after a memory-related interaction, double-check:

1. The `command` field resolves correctly. If using `"command": "memento"`, verify with `which memento` from a shell that the same `$PATH` would expose to the client. If your client uses a stripped-down environment, prefer `"command": "npx"` with `"args": ["@psraghuveer/memento", "serve"]`, or use the absolute path printed by `which memento`.
2. Shell features like `&&` will not work — MCP clients spawn the command directly, not via a shell.
3. The `MEMENTO_DB` directory is writable by the user the client runs as.

For deeper troubleshooting (build errors, permission errors, `STORAGE_ERROR`s), see [`docs/guides/troubleshooting.md`](troubleshooting.md).
