# Operations

Day-two tasks for a running Memento install: checking health, taking backups, running compaction, and scheduling those things so you don't have to remember to.

The store is a single SQLite file. Every operations task is therefore either a CLI subcommand or a filesystem operation; there is no daemon to manage.

## Inspect the store

`memento status` prints a structured snapshot of the live database without opening an MCP transport. It is the right command to run from a cron job, a healthcheck, or just before a backup.

```bash
memento status
```

Fields in the snapshot:

- `version` — CLI version that produced the snapshot.
- `dbPath` — resolved database path (`--db` > `MEMENTO_DB` > XDG default, e.g. `~/.local/share/memento/memento.db`).
- `dbBytes` — size of the SQLite file on disk.
- `memoryCount`, `memoryByKind` — total active memories and per-kind breakdown (`fact`, `preference`, `decision`, `todo`, `snippet`).
- `conflictCount` — number of unresolved conflicts (rows with `resolved_at IS NULL`).
- `lastEventAt` — most recent audit event timestamp; useful as a "last write" liveness signal.
- `vectorEnabled` — whether `retrieval.vector.enabled` is `true` in config.

For a deeper readiness check (Node version, embedded engine, embedder resolution, MCP client config files), use:

```bash
memento doctor          # full probe
memento doctor --quick  # skip DB, embedder, MCP scans
memento doctor --mcp    # also scan known MCP client config files
```

To smoke-test the MCP transport itself (spawn `serve` as a child, run the JSON-RPC handshake, list tools, exit), use:

```bash
memento ping
```

`ping` returns the tool count and tool names, plus elapsed milliseconds. It opens and closes a real MCP session; if your assistant claims Memento isn't responding, this is the first thing to run.

## Serve diagnostics log

When `memento serve` is launched by an MCP client, its stderr is usually invisible. To make startup failures recoverable, `serve` appends JSON lines to `$XDG_STATE_HOME/memento/serve.log` (POSIX default: `~/.local/state/memento/serve.log`; Windows: `%LOCALAPPDATA%\memento\serve.log`) when:

- the database fails to open (`event: "open-failed"`), or
- the stdio transport throws (`event: "transport-failed"`).

Each line is a single JSON object with `ts`, `level`, `event`, `dbPath`, and `message`. The error envelope returned to the client also carries a `hint` pointing at this log so you can `tail` it after the fact.

If `doctor` reports `native-binding` failed, the most common cause is a `better-sqlite3` ABI mismatch after a Node upgrade. Fix:

```bash
npm rebuild better-sqlite3 --build-from-source
```

The CLI's `postinstall` script attempts this automatically on install; this command is the manual fallback.

## Compact

Memento accumulates archived and forgotten memory rows over time. The `compact run` command sweeps the active corpus, applies decay, and transitions any memory whose effective confidence has fallen below `decay.archiveThreshold` to `archived` status. Archived memories remain in the database — `memento memory read <id>` still returns them — they just stop competing in retrieval and stop bumping `lastConfirmedAt`.

```bash
memento compact run
```

There is no required cadence — running it weekly is fine for stores in the low thousands of memories. The half-life and archive threshold are tunable; see [`docs/reference/config-keys.md`](../reference/config-keys.md) under `decay.*` and `compact.*`.

`compact run` does **not** prune audit events. The `memory_events` log is append-only by design; a separate retention knob doesn't exist today. See [KNOWN_LIMITATIONS.md](../../KNOWN_LIMITATIONS.md) under "No audit-event retention pruning."

## Backup

`memento backup <destination>` writes a consistent snapshot of the live database via SQLite's `VACUUM INTO`. The source database can be open and in use; SQLite handles the locking.

```bash
memento backup ~/memento-backups/$(date +%Y-%m-%d).db
```

Behaviour:

- The destination's parent directory is created if missing.
- The command refuses to overwrite an existing file unless you pass `--force`.
- An in-memory database (`MEMENTO_DB=:memory:`) cannot be backed up — there's nothing on disk to snapshot. The command rejects this case explicitly.

Backups are ordinary SQLite files. To restore, either:

- Point `MEMENTO_DB` at the snapshot to use it directly, or
- Stop any process holding the live database open and `cp` the snapshot over the live path.

## Schedule the routine tasks

Compaction and backups are the two things worth scheduling. A minimal `crontab(5)` entry on macOS / Linux:

```cron
# weekly compact, Sunday 03:00 local
0 3 * * 0 /usr/local/bin/memento compact run >> ~/.local/state/memento-compact.log 2>&1

# daily backup, 03:30 local, with a 14-day rolling retention
30 3 * * * /usr/local/bin/memento backup ~/memento-backups/$(date +\%Y-\%m-\%d).db && find ~/memento-backups -type f -name '*.db' -mtime +14 -delete
```

Pick paths that match your install (`which memento`) and your `MEMENTO_DB` location. Cron jobs run with a stripped environment; either export `MEMENTO_DB` in the cron line itself or pass `--db /abs/path/to/memento.db` explicitly.

On systemd-flavoured systems a pair of `*.timer` units works equivalently and is easier to inspect with `systemctl list-timers`.

## Pre-upgrade ritual

Before upgrading the package in place:

```bash
memento backup ~/memento-backups/pre-upgrade-$(date +%Y-%m-%d).db
npm i -g @psraghuveer/memento@latest
memento doctor
memento status
```

If `doctor` or `status` flags anything unexpected, the snapshot you took in step one is your rollback. Migrations are append-only (Rule 12), so a newer binary can always read an older database — but a database written by a newer binary may rely on schema features the older binary lacks, which is why the rollback path is "restore the snapshot," not "downgrade the package."

If you want a quantitative before/after — useful when an upgrade touches retrieval or storage — capture a stress-test baseline on each side of the upgrade and diff the two markdown reports. From a checkout of the source repo:

```bash
node scripts/stress-test.mjs --mode=standard   # before upgrade
# ... upgrade ...
node scripts/stress-test.mjs --mode=standard   # after upgrade
diff ./memento-stress-<before>.md ./memento-stress-<after>.md
```

The runner uses a fresh, throwaway database under `/tmp/`, so it never touches the live store. See [`docs/guides/stress-test.md`](stress-test.md) for the full guide.

## Uninstall

`memento uninstall` prints \(does not perform\) the steps to remove every artefact Memento creates: the database file plus each known MCP-client config entry. It is intentionally print-only so you can review and execute the steps yourself.

```bash
memento uninstall
```

The output enumerates: the database path, per-client config files (`~/.claude.json`, project `.mcp.json`, `claude_desktop_config.json`, `~/.cursor/mcp.json`, `.vscode/mcp.json`, `~/.config/opencode/opencode.json`), and the npm package. Steps that don't apply on your machine (a missing config file, a not-globally-installed package) are still printed for completeness.
