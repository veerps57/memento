# Teach your assistant

Memento exposes a set of MCP tools (`write_memory`, `search_memory`, `confirm_memory`, `get_memory_context`, etc.) but it does not, by itself, teach an AI assistant *when* to use them. That part is up to you.

This guide is a starter pack of prompt fragments you can drop into your assistant's persona file (`CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`, OpenCode prompt, custom system prompt) so the assistant uses Memento well from the first conversation.

The fragments below are deliberately short and opinionated. Adapt them to your usage.

## Shortcut: use the bundled skill (Claude Code / Cowork)

If your AI client supports [Anthropic skills](https://docs.claude.com/en/docs/agents/skills) — Claude Code and Cowork do today — install [`skills/memento/`](../../skills/memento/SKILL.md) and you can skip most of this guide. The skill encodes the same rules, loads automatically on intent match, and stays versioned with the rest of Memento. See [`skills/README.md`](../../skills/README.md) for install steps.

Other clients (Cursor, Cline, OpenCode, VS Code Agent mode) do not support skills today. For those, the persona snippet below is still the supported approach.

## Core directive

Paste this near the top of the persona file. It establishes the contract: Memento is the durable memory; chat history is not.

```text
You have access to Memento, a local memory store, via MCP tools.
Treat it as the canonical place for durable facts about the user,
their preferences, and their projects. Treat the current chat
session as ephemeral — anything you want to remember beyond this
session must be written to Memento.

At the start of each task, call `get_memory_context` to load relevant
memory. Before answering questions about the user's preferences
or past decisions, call `search_memory` first; do not guess from
chat history alone.

Memory operations are silent background plumbing — never narrate
them. Don't preface tool calls ("let me check memory first") and
don't report results ("memory was empty", "saved as a global
preference"). The UI shows the tool call; your prose on top is
noise. Speak only when (a) the user asked a question whose answer
is in memory, (b) a write surfaced a conflict the user must
resolve, or (c) the user explicitly said "remember this" — and
even then, one word ("noted") is enough.
```

## When to write

The most common failure mode is an assistant that never writes anything to Memento, or that writes everything indiscriminately. The middle path is "write distilled, structured assertions, not raw transcript."

```text
Write to Memento when the user states something durable about
themselves, their preferences, their tools, or their projects —
e.g. "I prefer pnpm over npm", "the staging cluster lives at
gke-staging", "I always squash-merge PRs", "I write in British
English", "my target audience is mid-career professionals",
"I prefer concise summaries over verbose explanations". Use
`write_memory` with an explicit `kind` (`fact`, `preference`,
`decision`, `todo`, or `snippet`) and a tight `content` field
of one or two sentences.

Do not write transient context (the file you are currently
editing, the error message you just saw, what the user typed
five minutes ago). Memento is not a chat log.
```

### Use a `topic: value` first line for preferences and decisions

Conflict detection on `preference` and `decision` memories parses the *first line* of `content` as `topic: value` (or `topic = value`). Two memories with the same topic and different values are flagged for triage. Free-prose content without a parseable first line never conflicts — so an assistant that writes "Raghu prefers bun" today and "Raghu uses npm" tomorrow leaves both rows active with no surfaced contradiction.

Teach the assistant the two-line shape:

```text
For `preference` and `decision` memories, start `content` with a
single `topic: value` line followed by free prose for context.
The first line is the structural anchor that conflict detection
parses; without it, contradictory preferences silently coexist
instead of being surfaced to the user.

Example:
  node-package-manager: pnpm

  Raghu prefers pnpm over npm for Node projects — disk-efficient
  and faster on his laptop.

`fact`, `todo`, and `snippet` use different conflict heuristics
and don't need the first-line anchor.
```

### Attribute statements with the user's preferred name

`info_system` exposes `user.preferredName`. Read it once at session start and use it when authoring memory content (`Raghu prefers pnpm` rather than `User prefers pnpm`). The user sets it via `memento config set user.preferredName "<name>"`. When `null`, write "The user" — never invent a name from chat context.

```text
At session start, call `info_system` and read `user.preferredName`.
Use that name when writing memory content (e.g. "Raghu prefers
pnpm"). If it is null, use "The user" instead. Do not invent a
name from chat context — the config key is the only source of
truth for how to refer to the user.
```

## When to confirm

`get_memory_context` and `search_memory` return memories without bumping their `lastConfirmedAt` timestamp. The timestamp only moves when the assistant explicitly calls `confirm_memory` after actually using the memory. This keeps decay semantics meaningful — a memory that is loaded into context but never acted on still ages.

```text
When you actually rely on a memory to answer a question or shape
a code change, call `confirm_memory` with that memory's id. If
you only loaded it speculatively and didn't use it, do not
confirm. The confirmation signal feeds the decay engine; lying
to it makes ranking worse over time.
```

## When to supersede vs. update

Memento's `update_memory` is restricted to non-content fields (tags, kind, pinned, sensitive). A content change must go through `supersede_memory`, which preserves both rows and links them.

```text
If the user changes their mind about something durable
("actually, I switched to bun"), call `supersede_memory` with
the old memory's id and a new memory describing the current
state. Do not call `update_memory` with the new content — the
schema rejects it, and even if it didn't, you would lose the
"what did the user think before" history that makes Memento
useful.
```

## When to flag a conflict

Memento detects conflicts automatically on write and stores them in the `conflicts` table. The assistant's job is not to resolve them — that is a human-in-the-loop decision — but to surface them honestly.

```text
If `write_memory` returns a conflict notice, do not retry the
write or attempt to auto-resolve. Tell the user that the new
information disagrees with an existing memory, show both, and
ask which one to keep. The user can then resolve via
`npx @psraghuveer/memento conflict resolve` (CLI) or by giving you the answer
in chat.
```

## Privacy

Memento ships a regex scrubber that strips obvious secrets before write. It is best-effort, not bulletproof.

```text
Do not deliberately write secrets, tokens, or credentials to
Memento, even if the user pastes them in chat. The built-in
scrubber catches common formats but not all of them. If the
user asks you to remember a credential, decline and suggest
they store it in their password manager instead.
```

## Approve Memento tools in your client

Most MCP-capable clients prompt for permission on every tool call by default. With Memento — which calls `get_memory_context` at session start, `confirm_memory` while working, and `extract_memory` before sign-off — that prompt cascade buries the conversation. Pre-approve the Memento tools once and the prompts go away. This is a one-time client-side setting; no instruction in the persona file can grant Claude permission on its own behalf.

- **Claude.ai (web/desktop):** Settings → Connectors → Memento → toggle "always allow" per tool. The setting is per-tool, so do it for at least the read-only ones (`get_memory_context`, `search_memory`, `read_memory`, `info_system`, `list_*`) and the routine writers (`write_memory`, `confirm_memory`, `extract_memory`). Leave destructive tools (`forget_memory`, `archive_memory`, `forget_many_memories`, `archive_many_memories`, `resolve_conflict`) prompting if you want a confirmation gate on those.
- **Claude Code:** add Memento patterns to `permissions.allow` in `~/.claude/settings.json` (or run `/permissions` and grant interactively). The wildcard `mcp__memento__*` covers the whole server in one entry; narrow it to specific tools if you want destructive operations to keep prompting.
- **Cursor / Cline / OpenCode / VS Code Agent Mode:** look for the per-tool approval setting in the MCP server config — every client surfaces it differently, but most have one.

The alternative — clicking "approve" on every memory call — turns Memento from invisible plumbing into a paper-cut machine and trains users to ignore approval dialogs entirely.

## A minimal end-to-end persona snippet

For copy-paste, here is a compact version of the above that fits in a `CLAUDE.md`-style file without padding:

```text
## Memory (Memento)

You have a local memory store via MCP. Use it as your durable
memory; treat chat as ephemeral.

- Memory ops are silent background plumbing. Don't preface them
  ("let me check memory") and don't report results ("saved",
  "memory was empty"). The UI shows the tool call; layering prose
  on top pollutes the conversation. Speak only when the user
  asked a question whose answer is in memory, a write surfaced a
  conflict, or the user explicitly said "remember this" — and
  then one word ("noted") is enough.
- At the start of a task, call `get_memory_context` to load relevant
  memories for this session. If context looks thin, call
  `search_memory` with specific terms.
- When you actually use a memory, call `confirm_memory` with its id.
- Write durable user statements (preferences, decisions, facts,
  todos, snippets) via `write_memory` with an explicit `kind`.
- Before ending a session, call `extract_memory` with a batch of
  candidates for anything worth remembering that wasn't written
  explicitly during the conversation. The server deduplicates
  automatically — when in doubt, include it. The default
  configuration is async: the response will be `{written:[],
  skipped:[], superseded:[], mode:"async", batchId, hint, status:
  "accepted"}` — that is the receipt, not a failure. Writes land
  as memories within seconds; do not retry.
- For preferences and decisions, start `content` with a single
  `topic: value` line followed by prose. Conflict detection
  parses that line; without it, contradictory preferences
  silently coexist.
- Use the user's preferred name from `info_system.user.preferredName`
  when authoring memory content; fall back to "The user" when
  that field is null.
- For changes of mind, use `supersede_memory`, not `update_memory`.
- Never write secrets, tokens, or credentials.
```

## Verifying it works

After updating the persona file:

1. Start a fresh chat session.
2. Tell the assistant a durable preference ("I prefer Vitest over Jest").
3. End the session, start a new one, ask "what testing framework do I use?" — the assistant should call `search_memory`, find the preference, and answer without re-asking.
4. Run `npx @psraghuveer/memento list` from a terminal to confirm the memory is on disk.

If step 3 fails, the most common causes are: the persona file isn't actually loaded by the client, the client is pointed at a different `MEMENTO_DB`, or the assistant didn't write the preference in the first place. `npx @psraghuveer/memento doctor --mcp` and `npx @psraghuveer/memento ping` triage the first two; tightening the "When to write" section addresses the third.
