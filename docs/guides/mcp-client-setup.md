# Wiring Memento into an MCP client

Memento ships as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Any MCP-aware client — Claude Desktop, Claude Code, Cursor, Cline, Aider, OpenCode, VS Code's Agent mode, and so on — can talk to it the same way: by spawning the `npx @psraghuveer/memento serve` process and exchanging JSON-RPC over stdin/stdout.

This guide is written for both human operators and AI agents. The configuration snippets are concrete and copy-paste ready; the "why" notes are short and one click away from the supporting docs.

## Quickstart — three steps

The fastest path is to let Memento generate every snippet for you, with the resolved database path already filled in:

### 1. Initialize Memento

```bash
npx @psraghuveer/memento init
```

`init` creates the database under the XDG default (`$XDG_DATA_HOME/memento/memento.db`, typically `~/.local/share/memento/memento.db` on POSIX and `%LOCALAPPDATA%\memento\memento.db` on Windows), runs migrations, and prints copy-paste MCP snippets for every supported client. Idempotent — re-run any time to reprint the snippets. To pick a non-default location, pass `--db /custom/path/memento.db` or set `MEMENTO_DB` in your environment before running `init`.

To target a subset of clients, pass `--client` (csv): `npx @psraghuveer/memento init --client claude-code,opencode`.

### 2. Connect your AI client

For each client, `init` prints either a one-line subcommand (e.g. `claude mcp add memento …` for Claude Code) or a JSON snippet to merge into the client's MCP config. Pick the path for your client below, paste, then **restart the client** so it loads the new MCP server.

### 3. Teach your assistant when to use Memento

Memento ships the MCP tools; the assistant still needs to know *when* to call them. Three teaching surfaces, ordered by reliability:

- **Persona snippet (universal, always-on).** Paste the snippet from [`teach-your-assistant.md`](teach-your-assistant.md) into wherever your client stores user-defined system prompt content — the field name varies (`CLAUDE.md`, `.cursorrules`, "Custom Instructions" in your client's settings UI, etc.). On a TTY, `memento init` offers to auto-write this block into detected file-based clients (Claude Code / OpenCode / Cline) for you; just press `Y` at the prompt. This is the only teaching surface guaranteed to reach the assistant's system prompt on every message.
- **Bundled skill (on-intent enrichment for skill-capable clients).** If your client loads Anthropic-format skills, install the bundled [skill](../../skills/memento/SKILL.md). One `cp -R`, printed by `init`, copies it into `~/.claude/skills/`. The skill fires on memory-relevant intent and layers the deeper distillation curriculum over the persona snippet.
- **MCP `instructions` spine (best-effort future-proofing).** The MCP server emits a session-start teaching spine on every `initialize` handshake (ADR-0026). Client implementations of the optional `instructions` field vary; treat the spine as a free bonus on clients that surface it, harmless on clients that drop it.

The full per-client walkthrough (Cline, custom paths, troubleshooting) is below.

## Prerequisites

The canonical invocation throughout this guide is `npx @psraghuveer/memento <cmd>`. The first run downloads and caches the package; subsequent runs reuse the cache. No global install is required, and the snippets below match exactly what `npx @psraghuveer/memento init` emits, so client configs work the same way regardless of who runs them.

Verify your install:

```bash
npx @psraghuveer/memento doctor
```

If you'd rather not type the full package name every time, you have two options:

- **Global install:** `npm install -g @psraghuveer/memento`. Now `memento` is on your `$PATH` and every example below works with the bare command. Client configs that use `"command": "npx"` will keep working too.
- **Shell alias:** `alias memento='npx -y @psraghuveer/memento'` in your shell rc.

**From a clone (contributors only).** Build the workspace and point clients at `node /abs/path/to/packages/cli/dist/cli.js`. See [`README.md`](../../README.md#getting-started) for the workspace setup.

## What every client needs

Memento's MCP transport is stdio only. Every client config boils down to four pieces of information:

1. A **command** to spawn (`npx`, with `@psraghuveer/memento` as the first arg; or the bare `memento` binary if you've installed globally).
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
      "command": "npx",
      "args": ["-y", "@psraghuveer/memento", "serve"],
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
      "command": "npx",
      "args": ["-y", "@psraghuveer/memento", "serve"],
      "env": {
        "MEMENTO_DB": "/Users/<you>/.local/share/memento/memento.db"
      }
    }
  }
}
```

After saving, restart Cursor. The MCP panel should list `memento` as connected; tool calls from chat will now route through it.

## Cline (VS Code extension)

Cline is **manual-config only** today — `memento init` does not emit a Cline snippet, and `memento doctor --mcp` does not scan its config files. You configure it by hand: open the Cline panel in VS Code, click the **MCP Servers** icon, and choose **Edit MCP settings**. Cline stores the result in `~/.config/Cline/mcp_servers.json` (Linux/macOS) or `%APPDATA%\Cline\mcp_servers.json` (Windows). The `memento` entry is the same JSON object as the Claude-Desktop snippet above.

## VS Code Agent mode

VS Code's Agent mode reads MCP servers from `.vscode/mcp.json` in the workspace root or from the user-level equivalent. Use the workspace file for project-scoped memory and the user file for global memory:

```json
// .vscode/mcp.json
{
  "servers": {
    "memento": {
      "command": "npx",
      "args": ["-y", "@psraghuveer/memento", "serve"],
      "env": {
        "MEMENTO_DB": "${workspaceFolder}/.memento/memento.db"
      }
    }
  }
}
```

`${workspaceFolder}` keeps the path relative to the project, which is appropriate when the database itself is project-scoped (`.gitignore` already excludes `memento.db` and the `.memento/` directory).

## OpenCode

OpenCode reads `~/.config/opencode/opencode.json`. Add `memento` under the `mcp` map. OpenCode accepts both an array form (`command: ["npx", "-y", "@psraghuveer/memento", "serve"]`) and a split `command` + `args` form; if `npx @psraghuveer/memento init` produced a snippet for a different client and you want to adapt it, the array form is usually what OpenCode expects:

```json
{
  "mcp": {
    "memento": {
      "type": "local",
      "command": ["npx", "-y", "@psraghuveer/memento", "serve"],
      "environment": {
        "MEMENTO_DB": "/Users/<you>/.local/share/memento/memento.db"
      }
    }
  }
}
```

Restart OpenCode after editing. If the server doesn't connect, run `npx @psraghuveer/memento doctor --mcp` — it scans the OpenCode config among other client configs and flags shape mismatches.

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

1. The `command` field resolves correctly. The default `"command": "npx"` requires Node.js to be on the `$PATH` of the shell the client uses to spawn servers — verify with `which npx` from a fresh login shell. If your client uses a stripped-down environment, prefer the absolute path: `"command": "/usr/local/bin/npx"` (or whatever `which npx` prints). If you've installed globally and switched the snippets to `"command": "memento"`, verify with `which memento` the same way.
2. Shell features like `&&` will not work — MCP clients spawn the command directly, not via a shell.
3. The `MEMENTO_DB` directory is writable by the user the client runs as.

For deeper troubleshooting (build errors, permission errors, `STORAGE_ERROR`s), see [`docs/guides/troubleshooting.md`](troubleshooting.md).

## Next: seed your store with a pack

A fresh Memento install is empty. The fastest way to get value from your assistant on day one is to install a pack — a curated YAML file of memories (typically a stack guide or a personal set of conventions) that you can install in one step:

```bash
memento pack install <id-or-path>
```

See [`packs.md`](packs.md) for the full guide: installing, authoring (`memento pack create`), the format spec, and the dashboard's Packs tab.
