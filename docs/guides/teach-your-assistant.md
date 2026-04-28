# Teach your assistant

Memento exposes a set of MCP tools (`memory.write`, `memory.search`, `memory.confirm`, `memento_context`, etc.) but it does not, by itself, teach an AI assistant *when* to use them. That part is up to you.

This guide is a starter pack of prompt fragments you can drop into your assistant's persona file (`CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`, OpenCode prompt, custom system prompt) so the assistant uses Memento well from the first conversation.

The fragments below are deliberately short and opinionated. Adapt them to your usage.

## Core directive

Paste this near the top of the persona file. It establishes the contract: Memento is the durable memory; chat history is not.

```text
You have access to Memento, a local memory store, via MCP tools.
Treat it as the canonical place for durable facts about the user,
their preferences, and their projects. Treat the current chat
session as ephemeral — anything you want to remember beyond this
session must be written to Memento.

At the start of each task, call `memento_context` to load relevant
memory. Before answering questions about the user's preferences
or past decisions, call `memory.search` first; do not guess from
chat history alone.
```

## When to write

The most common failure mode is an assistant that never writes anything to Memento, or that writes everything indiscriminately. The middle path is "write distilled, structured assertions, not raw transcript."

```text
Write to Memento when the user states something durable about
themselves, their preferences, their tools, or their projects —
e.g. "I prefer pnpm over npm", "the staging cluster lives at
gke-staging", "I always squash-merge PRs". Use `memory.write`
with an explicit `kind` (`fact`, `preference`, `decision`,
`todo`, or `snippet`) and a tight `content` field of one or two
sentences.

Do not write transient context (the file you are currently
editing, the error message you just saw, what the user typed
five minutes ago). Memento is not a chat log.
```

## When to confirm

`memento_context` and `memory.search` return memories without bumping their `lastConfirmedAt` timestamp. The timestamp only moves when the assistant explicitly calls `memento_confirm` after actually using the memory. This keeps decay semantics meaningful — a memory that is loaded into context but never acted on still ages.

```text
When you actually rely on a memory to answer a question or shape
a code change, call `memory.confirm` with that memory's id. If
you only loaded it speculatively and didn't use it, do not
confirm. The confirmation signal feeds the decay engine; lying
to it makes ranking worse over time.
```

## When to supersede vs. update

Memento's `memory.update` is restricted to non-content fields (tags, kind, pinned). A content change must go through `memory.supersede`, which preserves both rows and links them.

```text
If the user changes their mind about something durable
("actually, I switched to bun"), call `memory.supersede` with
the old memory's id and a new memory describing the current
state. Do not call `memory.update` with the new content — the
schema rejects it, and even if it didn't, you would lose the
"what did the user think before" history that makes Memento
useful.
```

## When to flag a conflict

Memento detects conflicts automatically on write and stores them in the `conflicts` table. The assistant's job is not to resolve them — that is a human-in-the-loop decision — but to surface them honestly.

```text
If `memory.write` returns a conflict notice, do not retry the
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

## A minimal end-to-end persona snippet

For copy-paste, here is a compact version of the above that fits in a `CLAUDE.md`-style file without padding:

```text
## Memory (Memento)

You have a local memory store via MCP. Use it as your durable
memory; treat chat as ephemeral.

- At the start of a task, call `memento_context` to load memory.
- Before answering questions about the user's preferences or
  past decisions, call `memory.search` first.
- When you actually use a memory to answer or act, call
  `memory.confirm` with its id.
- Write durable user statements (preferences, decisions, facts,
  todos, snippets) via `memory.write` with an explicit `kind`.
  Do not write transient context.
- For changes of mind, call `memory.supersede`, not
  `memory.update`. Updates cannot change content by design.
- If `memory.write` reports a conflict, show both sides and ask
  the user which to keep. Do not auto-resolve.
- Never write secrets, tokens, or credentials.
```

## Verifying it works

After updating the persona file:

1. Start a fresh chat session.
2. Tell the assistant a durable preference ("I prefer Vitest over Jest").
3. End the session, start a new one, ask "what testing framework do I use?" — the assistant should call `memory.search`, find the preference, and answer without re-asking.
4. Run `npx @psraghuveer/memento list` from a terminal to confirm the memory is on disk.

If step 3 fails, the most common causes are: the persona file isn't actually loaded by the client, the client is pointed at a different `MEMENTO_DB`, or the assistant didn't write the preference in the first place. `npx @psraghuveer/memento doctor --mcp` and `npx @psraghuveer/memento ping` triage the first two; tightening the "When to write" section addresses the third.
