---
'@psraghuveer/memento': patch
---

Onboarding-flow polish + new `memento skill-path` command.

- `memento skill-path` prints the absolute path of the staged Memento skill bundle on stdout, designed for shell embedding: `cp -R "$(memento skill-path)" ~/.claude/skills/`. Always emits the bare path even off-TTY (so `$(…)` substitution works inside scripts and pipes); the structured envelope is opt-in via `--format json`. Returns `NOT_FOUND` (exit 3) when the bundle isn't staged, with `details.suggestedTarget` preserved for callers.
- `memento init`'s walkthrough is now framed as three explicit numbered steps — *Initialize Memento* / *Connect your AI client* / *Teach your assistant when to use Memento* — matching the README, the landing page, and `docs/guides/mcp-client-setup.md`. Step 3 always renders, falling back to a generic persona-snippet pointer when the rendered client set has no skill-capable client (instead of silently dropping the section).
- The footer now suggests `memento doctor --mcp` (the variant that actually scans client config files) and explicitly tells users to **restart their AI client** after pasting — the missing nudge that was the most common "I pasted, asked a question, got nothing" failure.
- The `supportsSkills` flag on every registered client (`init-clients.ts`) is now the single source of truth for which clients load Anthropic-format skills; every other surface phrases the choice generically (*"if your client loads Anthropic-format skills"* / *"if it doesn't"*) so the copy doesn't drift as the ecosystem moves. Today every registered client (Claude Code, Claude Desktop, Cursor, VS Code, OpenCode) is skill-capable.
- The npm tarball gets a `prepack` insurance hook that re-runs `copy-skills.mjs`, so `npm pack` and `npm publish` can never ship a stale or missing skill bundle regardless of release workflow.
