# ADR-0028: Interactive `init` and the `verify-setup` command

- **Status:** Accepted
- **Date:** 2026-05-17
- **Deciders:** Raghu + Claude
- **Tags:** cli, init, onboarding, verification, adoption

## Context

`memento init` is the entry point of every install. Today it does three things well — opens / migrates the database, runs pre-flight checks, prints MCP-client snippets — and stops at "paste this snippet into your client's config." Three steps remain on the user:

1. Paste the MCP snippet into the client's config file (or run `claude mcp add` for Claude Code).
2. Optionally `cp -R` the bundled skill into `~/.claude/skills/`.
3. Restart the client.

Each is a drop-off point. Worse, two structural gaps make the post-install state itself thin:

- **`user.preferredName` is null but never prompted for.** The skill and the `instructions` spine ([ADR-0026](0026-mcp-instructions-as-session-teaching-spine.md)) both say "use `info_system.user.preferredName` when writing memory content; never invent a name." Result: every memory written about the user reads "The user prefers X" instead of "Raghu prefers X." The fix is one config key and one prompt; we just never asked.
- **The store is empty on day one.** `get_memory_context` returns `{results: []}` and the assistant has nothing to say. We ship four curated packs (`engineering-simplicity`, `pragmatic-programmer`, `google-sre`, `twelve-factor-app`) — any of them is a meaningful starting corpus, and the user is one `memento pack install` away. We just never offer.

Separately, the install journey has no end-to-end verification beyond "run `memento doctor`." Doctor confirms the host is healthy (Node version, DB writable, native binding present, embedder peer dep present) but does not exercise the round-trip the user actually cares about: "can the assistant write a memory through the MCP server I just configured." Users find out only when their assistant fails silently mid-session.

## Decision

Two changes ship together as one onboarding revamp:

### 1. `memento init` becomes interactive by default

On a TTY, `init` prompts for four one-keystroke questions after the existing pre-flight checks, before printing the client snippets:

1. **`user.preferredName`** — "What should the assistant call you? (press Enter to skip)" — if a non-empty value is entered, `config set user.preferredName "..."` runs immediately.
2. **Install the skill** — "Install the Memento skill into `~/.claude/skills/`? [Y/n]" — on `y` (default), runs the `cp -R` for the bundled skill source. Idempotent: re-running `init` re-checks and skips if the skill is already current.
3. **Seed with a starter pack** — "Seed your store with a starter pack? [`engineering-simplicity`/`pragmatic-programmer`/`google-sre`/`twelve-factor-app`/N]" — on selection, runs `memento pack install <id>` in the same process.
4. **Auto-install the persona snippet** — "Auto-install the persona snippet into detected file-based clients? [Y/n]" — on `y` (default), writes the marker-wrapped persona block to every detected file-based client's user-scope custom-instructions file (`~/.claude/CLAUDE.md` for Claude Code, `~/.config/opencode/AGENTS.md` for OpenCode, `~/Documents/Cline/Rules/memento.md` for Cline). Idempotent and removable; added as a fourth prompt in 0.9.0 (see the persona-installer details in that release's changeset). UI-only clients (Cowork, Claude Desktop, Claude Chat, Cursor User Rules) surface as per-target paste hints in the rendered walkthrough instead.

All four are skipped silently when stdout is not a TTY (pipes, redirects, CI). A new `--no-prompt` flag forces the print-only behavior on a TTY for users who want to script `init` without changing their shell setup. A new `--prompt-all` flag (default behavior on TTY) makes the intent explicit and is what scripts can pass when they want interactivity in a non-TTY context (rare).

The walkthrough text trims accordingly: when the skill section has already been resolved (installed or declined) and the starter pack has been resolved, the printed walkthrough drops those sections rather than re-presenting them.

### 2. New CLI command: `memento verify-setup`

`verify-setup` is the end-to-end round-trip check. It spawns `memento serve` as a child MCP server (via stdio), connects an in-process MCP client, and exercises a smoke-test sequence:

1. `tools/list` — verify the expected tool set is exposed.
2. `info_system` — verify the server is healthy and report counts.
3. `write_memory` — write a transient memory tagged `memento:verify-setup` (kind: `snippet`).
4. `search_memory` — verify the memory is retrievable by tag.
5. `forget_memory` — clean up the test row (with `reason: "verify-setup teardown"`).

Each step is reported as a `VerifyCheck` entry — name, ok, message — matching the shape used by `doctor`'s checks. Failure at any step short-circuits and surfaces the underlying error.

`verify-setup` is CLI-only; it has no MCP surface (the whole point is that it exercises the MCP transport from the outside). It is intentionally separate from `doctor`: `doctor` confirms the host can run the server; `verify-setup` confirms a wired-up client can actually use it. Both ship with `--format json` for scripts and `--format text` for humans, matching the rest of the CLI's render contract.

## Consequences

### Positive

- Day-one install lands with the user's name set, the skill installed, and a starter pack seeded — three drop-offs removed.
- Assistants stop writing "The user prefers X" because the name prompt makes `preferredName` the default state, not the exceptional one.
- `verify-setup` closes the install loop: the user sees an explicit "your assistant can write to Memento" confirmation, not a maybe-it-works silence.
- The interactive prompts are skippable (`--no-prompt`) and TTY-aware (silent on pipes), so existing scripted setups are unaffected.

### Negative

- `init` is no longer a pure pure-print command — it can side-effect the config file (preferredName), the skills directory (`cp -R`), and the database (pack install). This breaks the [`init.ts`](../../packages/cli/src/lifecycle/init.ts) header's "print-only by design" framing. The framing is updated; the rationale was a defensible default that's now actively harmful.
- `verify-setup` adds a new spawn-then-exit pattern to the CLI. It is essentially `memento serve` plus an MCP client plus teardown — non-trivial code surface. Mitigation: factored to reuse `build-server`'s adapter and an in-memory MCP transport from the SDK; the new code is ≤200 lines.

### Risks

- A user runs `init` on a TTY, types Enter on the name prompt to skip, and ends up with `preferredName: null` — the same state as today, but with an extra prompt. Mitigation: the prompt copy explains why; users who skip are intentional. Re-running `init` re-prompts (idempotent), so changing your mind is easy.
- Pack install fails mid-`init` (network, embedder, etc.) and leaves the user in a partial state. Mitigation: pack install runs in its own transaction; failure prints the standard pack-install error and leaves the rest of `init` (snippet print, skill install) intact. Re-running `init` is safe.
- `verify-setup` writes a real memory to the user's real store. Mitigation: the tag `memento:verify-setup` is reserved and the cleanup step always runs (with a follow-up `--force-cleanup` flag for the rare case of an interrupted run leaving the row behind).

## Alternatives considered

### Alternative A: keep `init` print-only; add a separate `setup` command

- Two commands: `init` (existing) for the snippet print; `setup` (new) for the interactive prompts.
- Attractive: preserves the "init does one thing" framing.
- Rejected: the user has to *know* to run `setup` after `init`. The whole reason `init` exists is to be the one command a user runs after `npm install`. Splitting the journey across two commands re-introduces the drop-off `init` was supposed to remove.

### Alternative B: prompt only on first run; auto-suppress on re-run

- Track an `init.completedAt` flag; prompt only when null.
- Attractive: avoids re-prompting a user who has already answered.
- Rejected: the prompts are useful on re-run too — a user who skipped the name prompt last time and wants to set it now would have to manually run `config set`. Letting the prompts re-fire (with the existing-value shown as the default) is friendlier and a one-keystroke confirm.

### Alternative C: `verify-setup` as a flag on `doctor`

- `memento doctor --mcp-roundtrip` runs the same smoke test.
- Attractive: one entry point.
- Rejected: `doctor` is a host health check; `verify-setup` is a wiring round-trip. Mixing them blurs both surfaces, and the failure modes are different ("the binding is missing" vs "the client config is wrong"). Two commands stay sharper.

## Validation against the four principles

1. **First principles.** The user wants their assistant to work after install. Three drop-offs and a missing round-trip check map directly to "user installs, asks a memory question, gets no answer, gives up." The fix is the one command we already have; the verify is the one command we did not.
2. **Modular.** `verify-setup` reuses `buildMementoServer` and an in-process MCP transport — no parallel implementation. The interactive prompts in `init` factor into a single `promptStep` helper that the snapshot test can drive deterministically.
3. **Extensible.** Adding a fourth prompt (e.g. "Open the dashboard in your browser?") is a one-entry addition to the prompt sequence. Adding a sixth `verify-setup` check is one new `VerifyCheck` entry.
4. **Config-driven.** Prompt defaults (skill-on-by-default, pack-default-`engineering-simplicity`) are tunable via new config keys (`init.promptInstallSkill`, `init.defaultStarterPack`) so an organization shipping a custom distro can set its own defaults without forking the CLI.

## References

- ADR-0026: MCP `instructions` as the session-teaching spine (the spine references `info_system.user.preferredName`, which the name prompt populates).
- ADR-0020: Memento packs (the starter-pack prompt uses the existing pack install flow).
- [`packages/cli/src/lifecycle/init.ts`](../../packages/cli/src/lifecycle/init.ts) — current `init` implementation.
- [`packages/cli/src/init-render.ts`](../../packages/cli/src/init-render.ts) — current text renderer (target of the trim).
