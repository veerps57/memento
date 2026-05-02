# Troubleshooting

This guide covers the failure modes a fresh clone is most likely to hit. Each section names the visible symptom (the literal string a human reads or an AI agent should pattern-match against), explains the cause, and gives the fix. Symptoms are quoted verbatim so a search lands here.

For the full list of out-of-scope features and current limitations see [`KNOWN_LIMITATIONS.md`](../../KNOWN_LIMITATIONS.md).

## "Cannot find module 'better-sqlite3'" or a node-gyp build error during `pnpm install`

**Symptom.** During `pnpm install`, you see one of:

```text
Error: Cannot find module 'better-sqlite3'
```

```text
gyp ERR! find Python
gyp ERR! stack Error: Could not find any Python installation to use
```

```text
node-gyp: not ok
```

**Cause.** `better-sqlite3` is a native module. pnpm tries to download a prebuilt binary that matches your platform; if your platform isn't covered or the prebuild fetch fails, it falls back to compiling from source, which needs a working C/C++ toolchain.

**Fix.** Install the toolchain for your OS, then rerun `pnpm install`:

- **macOS:** `xcode-select --install`
- **Debian/Ubuntu:** `sudo apt-get install -y build-essential python3`
- **Fedora/RHEL:** `sudo dnf groupinstall -y "Development Tools" && sudo dnf install -y python3`
- **Alpine:** `apk add --no-cache python3 make g++`
- **Windows:** install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload, plus a recent Python 3.

Then:

```bash
rm -rf node_modules
pnpm install
```

If you're on a less common platform (uncommon glibc version, exotic arch), the prebuild may simply not exist and a from-source compile is the supported path. Supported prebuild platforms are tracked in [`KNOWN_LIMITATIONS.md`](../../KNOWN_LIMITATIONS.md).

## "command not found: memento"

**Symptom.**

```text
zsh: command not found: memento
```

**Cause.** `memento` isn't on your `$PATH`. Most commonly: you ran `npx @psraghuveer/memento <cmd>` in a previous shell. `npx` fetches and runs the package once — it does **not** install anything onto `$PATH`.

**Fix.** Pick one of:

- **Use `npx` every time.** Stateless and explicit:

  ```bash
  npx @psraghuveer/memento doctor
  npx @psraghuveer/memento serve
  ```

- **Install globally** so the bare `memento` command is available:

  ```bash
  npm install -g @psraghuveer/memento
  memento doctor
  ```

- **From a clone** (contributors): build once and call the CLI directly. `pnpm dev:server` builds the four packages the CLI needs (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`, `@psraghuveer/memento-server`, `@psraghuveer/memento`) and then runs `node packages/cli/dist/cli.js serve`. To invoke arbitrary subcommands:

  ```bash
  pnpm build
  node packages/cli/dist/cli.js context
  node packages/cli/dist/cli.js memory list
  ```

For MCP-client wiring (Claude Desktop, Cursor, Cline, OpenCode, VS Code Agent), see [`docs/guides/mcp-client-setup.md`](mcp-client-setup.md).

## "STORAGE_ERROR: failed to open database at ..."

**Symptom.** Any CLI invocation prints:

```text
{
  "ok": false,
  "error": {
    "code": "STORAGE_ERROR",
    "message": "failed to open database at '<path>': <details>"
  }
}
```

The CLI exits with code 5 (`STORAGE_ERROR`); see [`docs/reference/error-codes.md`](../reference/error-codes.md) for the full mapping.

**Cause.** Memento could not open or create the SQLite file at the resolved path. Common reasons:

1. **Parent directory does not exist.** SQLite creates the file but not its parent. `--db /var/lib/memento/store.db` fails if `/var/lib/memento/` doesn't exist.
2. **No write permission on the parent directory** (or no read permission on an existing file).
3. **Path resolves to a directory, not a file.** `--db ~/.memento` fails if `~/.memento/` is itself a directory.
4. **Disk is read-only or out of space.**
5. **Database file is corrupt** (rare; usually only happens after a forced kill mid-write or filesystem-level damage).

**Fix.** Inspect the resolved path. The precedence is `--db` > `MEMENTO_DB` > XDG default (`$XDG_DATA_HOME/memento/memento.db`, e.g. `~/.local/share/memento/memento.db`), so:

```bash
# Show what Memento would actually use:
node packages/cli/dist/cli.js --format json context 2>&1 | jq -r '.value.dbPath'
```

If the path looks wrong, override it. If the path is right, fix the filesystem:

```bash
# Make sure the parent dir exists and is writable:
mkdir -p "$(dirname /abs/path/to/memento.db)"

# Verify write access:
touch /abs/path/to/memento.db.test && rm /abs/path/to/memento.db.test
```

For corrupt-database recovery, the standard SQLite recipe applies: `sqlite3 <file> .recover > dump.sql`, then replay `dump.sql` into a fresh file. Memento's audit log is append-only, so a recovered dump that loses the most recent events is still internally consistent.

## "STORAGE_ERROR: ... disk I/O error" right after deleting `memento.db`

**Symptom.** You ran `rm ~/.local/share/memento/memento.db` to "start over," and the next `memento init` (or any open) prints:

```text
STORAGE_ERROR: failed to open database at '<path>': disk I/O error
```

**Cause.** Memento opens its database in WAL mode, which produces sidecar files (`memento.db-wal`, `memento.db-shm`, occasionally `memento.db-journal`) alongside the main `.db`. SQLite owns those sidecars and recovers from them on next open. If you remove only the main `.db`, SQLite finds a half-deleted store on the next open — a brand-new `.db` plus old WAL/SHM files that no longer match — and the recovery surfaces as the misleading `disk I/O error` above.

**Fix.** Modern Memento (`memento init` from this version onward) detects the half-deleted-store state and removes the orphan sidecars automatically. The cleanup is observable in the init snapshot as a `stale-wal-sidecars` `InitCheck`. If you're on an older release, the manual fix is:

```bash
rm ~/.local/share/memento/memento.db-wal ~/.local/share/memento/memento.db-shm
memento init
```

The cleanup is sound only when the main `.db` is absent; if the file exists, the sidecars belong to a live SQLite session and must not be touched.

## "CONFIG_ERROR: stored embedding for memory ..."

**Symptom.** A `memory.search` call (after enabling vector retrieval) returns:

```text
CONFIG_ERROR: stored embedding for memory <id> was produced by
'<old-model>' (dimension <n>) but the configured provider is
'<new-model>' (dimension <m>). Run `memento embedding rebuild`
to migrate stored vectors.
```

**Cause.** You changed `embedder.local.model` (or `embedder.local.dimension`) after writing memories with the old model. Memento refuses to score across mismatched vector spaces — that would silently corrupt ranking. This is Rule 14 in [`AGENTS.md`](../../AGENTS.md).

**Fix.** Run the rebuild command to re-embed every active memory under the new model. The CLI auto-wires the embedder when `retrieval.vector.enabled` is true (the default), so `embedding.rebuild` is available via `memento embedding rebuild`. See [`docs/guides/embeddings.md`](embeddings.md) for details.

## "Failed to load '@huggingface/transformers'"

**Symptom.**

```text
Failed to load '@huggingface/transformers'. Install it as a
dependency to use @psraghuveer/memento-embedder-local (e.g.
`pnpm add @huggingface/transformers`). See
packages/embedder-local/README.md for details.
```

**Cause.** A code path tried to call `embed()` on the local embedder, but `@huggingface/transformers` isn't resolvable. This typically indicates a broken or partial installation — since `@huggingface/transformers` is a regular dependency of `@psraghuveer/memento-embedder-local`, it should be present after a clean install.

**Fix.**

```bash
# Reinstall from scratch:
rm -rf node_modules
npm install -g @psraghuveer/memento
```

Or, if you are developing from a clone:

```bash
rm -rf node_modules packages/*/node_modules
pnpm install
```

Then re-run whatever triggered the embed call. The first call after install downloads the `bge-base-en-v1.5` ONNX model (~110 MB) into transformers.js's cache directory. See [`docs/guides/embeddings.md`](embeddings.md) for details.

## `pnpm dev:server` exits silently with a non-zero code

**Symptom.** You ran `pnpm dev:server` (with or without `--db`), saw the build messages scroll past, and then the process exited without printing a JSON error.

**Cause.** `memento serve` speaks MCP over stdio and exits when the peer disconnects. If you piped `/dev/null` into it, redirected stdin from a closed file, or ran it in a way that doesn't keep stdin open, the server reads EOF immediately and shuts down cleanly. The non-zero exit is the MCP transport's "peer disconnected" code wrapped by `pnpm`.

**Fix.** Don't redirect stdin. Run `pnpm dev:server` from an interactive shell so stdin stays open until you hit `Ctrl+C`, or wire it into a real MCP client (the supported case — see [`docs/guides/mcp-client-setup.md`](mcp-client-setup.md)). For a smoke check that doesn't require an MCP peer, run `npx @psraghuveer/memento context` instead:

```bash
pnpm build
node packages/cli/dist/cli.js context
```

That path opens the DB, prints the runtime snapshot, and exits cleanly.

## `memento serve` shows a single status line and then "hangs"

**Symptom.** You ran `memento serve` directly in a terminal and saw something like:

```text
memento 0.1.0 · MCP server ready on stdio · db: /Users/me/.local/share/memento/memento.db
press Ctrl-C to stop
```

…and then nothing. No prompt, no further output.

**Cause.** This is the correct behaviour, not a hang. `serve` speaks the Model Context Protocol over stdin/stdout and blocks until an MCP client connects (or until you press Ctrl-C). The readiness line is printed to **stderr** so it never corrupts the protocol on stdout, and it only appears when stderr is a TTY — when an MCP client launches the server with piped stderr, the line is suppressed so client logs stay clean.

**Fix.** Nothing to fix. To actually use the server, point an MCP client at it (see [`docs/guides/mcp-client-setup.md`](mcp-client-setup.md)). To smoke-test without an MCP peer, run `npx @psraghuveer/memento context` or `npx @psraghuveer/memento doctor` instead — both exit cleanly.

## Where to file issues

If you hit something that should be on this list and isn't, please open a [bug report](../../.github/ISSUE_TEMPLATE/bug_report.yml). Include the literal symptom string, your OS, your Node version (`node --version`), and your pnpm version (`pnpm --version`).

## Recipes

### Find and forget a memory by its content

When you don't remember the id, search by text first, then forget by id. The CLI ships sugar for both:

```bash
memento search "old project name"
# prints one line per hit:
#  01HZ...A1  fact   user  [project]  legacy reference to oldname...
memento forget 01HZ...A1
```

Under the hood `memento search "..."` calls `memory.search` with `--input '{"text":"..."}'`, and `memento forget <id>` calls `memory.forget`. To inspect a single record before deleting:

```bash
memento read 01HZ...A1
```

To list the most recent memories without searching:

```bash
memento list                # one line per row
memento list --format json  # machine-readable
```

### Back up before upgrading

Before `npm i -g @psraghuveer/memento@latest` (or any in-place upgrade), snapshot the database. Memento ships a built-in `backup` command that uses SQLite's `VACUUM INTO`, which is safe while another process is reading or writing the file:

```bash
memento backup ~/memento-backups/$(date +%Y-%m-%d).db
```

The destination's parent directory is created if missing. The command refuses to overwrite an existing destination unless you pass `--force`. Backups are plain SQLite files \u2014 to roll back, point `MEMENTO_DB` at the snapshot, or copy it over the live file while the server is stopped.

For scheduled backups and the rest of day-two operations, see [`operations.md`](operations.md).
