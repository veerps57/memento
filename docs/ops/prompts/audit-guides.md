You are auditing the Memento repo at `/Users/raghuveer/dev/memento` for drift between documentation and actual code/behavior. The user is preparing a "stale content cleanup" PR. You may be running alone or as one of several parallel agents covering different slices; cover only your slice.

## Your slice: docs/guides/ — 9 user-facing how-to docs

Files to audit:

- `docs/guides/conflicts.md`
- `docs/guides/dashboard.md`
- `docs/guides/embeddings.md`
- `docs/guides/mcp-client-setup.md`
- `docs/guides/operations.md`
- `docs/guides/packs.md`
- `docs/guides/stress-test.md`
- `docs/guides/teach-your-assistant.md`
- `docs/guides/troubleshooting.md`

These are the most user-facing docs and the highest drift risk: every command name, flag, default value, and example matters. A wrong example wastes user time at the moment they trust the doc most.

## What to look for, in priority order

1. **Command examples that don't work.** Every `memento foo bar --baz` and every `npx @psraghuveer/memento foo` example should map to a real command / flag in the CLI. Cross-check against:
   - `packages/cli/src/lifecycle/` — lifecycle commands (init, serve, dashboard, doctor, status, ping, context, backup, export, import, store-migrate, completions, explain, uninstall, skill-path, pack).
   - `docs/reference/cli.md` — auto-generated; treat as ground truth for the registry surface.
   - `packages/core/src/commands/` — registry-based commands.

   Spot-check 5–10 examples per guide. Flag any flag that doesn't exist or any subcommand that's been renamed. The repo has caught drifts here before — `memento compact` (without the `run` verb) is not a runnable command, the registry exposes `compact.run`; `--dry-run=false` is not a CLI flag form.

2. **Config key references.** Every `<namespace>.<key>` in the guide must exist in `packages/schema/src/config-keys.ts`. Spot-check.

3. **Default value claims.** "Default 10 seconds", "default 1 MiB", "halflife of 180 days for preferences" — verify against the actual default in `config-keys.ts`. Default values change rarely but visibly when they do.

4. **MCP tool names.** Verify every MCP tool mentioned (`memory.write`, `pack.install`, `config.set`) exists in `docs/reference/mcp-tools.md` (auto-generated, ground truth).

5. **File paths and locations.** "The model is cached at `~/.cache/memento/models`" — verify in `packages/embedder-local/src/`. "DB at `~/.local/share/memento/memento.db`" — verify in `packages/cli/src/lifecycle/init.ts` and the path resolver.

6. **Internal / session notes.** TODOs, FIXMEs, half-finished sentences, scratch text.

7. **Dead cross-references.** `[link](path)` should resolve. ADR refs must exist. The structural `pnpm docs:links` check catches the naive cases; verify any link whose context implies a specific target.

8. **Snapshot text.** When a guide quotes engine output (an error message, CLI output), verify it still matches what the code produces. Spot-check the most prominent output blocks.

9. **"Recently shipped" / "in v0.X" markers.** Verify it's still accurate (not ancient history) and not promising features that aren't there yet.

## Verify against actual code

Don't speculate. Read the relevant source files. If you can't verify a claim, say so explicitly.

## How to report

Plain text, file by file, line numbers cited. For each finding:

- File and line.
- Exact stale or wrong claim (quote the offending sentence or example).
- Correct version (or file + symbol to check).
- Severity: HIGH / MEDIUM / LOW.

Be opinionated about severity. A doc that tells someone to run `memento foo` when the command was renamed to `memento bar` is HIGH — every user who follows the example will fail.

Aim for 1500–2500 words.
