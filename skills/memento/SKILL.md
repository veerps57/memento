---
name: memento
description: How to use Memento — a local-first MCP memory layer for AI assistants — to remember and recall durable knowledge about the user, their preferences, conventions, decisions, and projects across sessions. Trigger this skill whenever the user has Memento connected and any of the following happens, even when the user does not explicitly say "remember it" — the user states something durable about themselves, their tools, their projects, or their conventions ("I prefer pnpm", "we squash-merge on main", "the staging cluster is gke-staging"); the user asks a "what is/was/did I" question that depends on prior context ("what's my preferred test runner?", "what did I decide about logging?"); the user changes their mind about something durable ("actually, I switched from X to Y"); the user asks to forget, archive, or stop suggesting something; or a fresh task starts and prior context would help. Also trigger when the user explicitly says "remember", "memorise", "save", or "note" something. Do NOT use this skill for transient context such as the file currently being edited, an error message that just appeared, or what the user typed five minutes ago — Memento stores distilled assertions, not transcripts. Do NOT use it for credentials, tokens, or secrets; those should never enter Memento at all.
---

# Memento

Memento is a local-first memory layer for AI assistants. Memory lives in one SQLite file on the user's machine and is reachable by any MCP-capable client. The same memories follow the user across tools, sessions, and reinstalls.

This skill teaches you to use Memento well. Read it once at session start; the rules are short and most of them turn on a single tool call.

## The available tools

The Memento MCP server exposes these tools (the `verb_noun` form is what shows up in `tools/list`). You only routinely need the ones in **bold**; the rest are for the user or for special cases.

- **`get_memory_context`** — load the most relevant memories with no query needed. Ideal session-start call.
- **`search_memory`** — full-text + paraphrase search. Use when you have a specific topic to look up.
- **`read_memory`** — fetch one memory by id. Always returns full content, even for memories marked sensitive.
- **`write_memory`** — create a single new memory.
- **`extract_memory`** — batch-write candidate memories from a conversation; the server dedups against existing memories.
- **`confirm_memory`** — re-affirm a memory you actually used. Resets its decay.
- **`supersede_memory`** — replace a memory's content with a new one and link the two.
- `update_memory` — change tags, kind, or pinned only (not content).
- `forget_memory` / `archive_memory` — destructive; require `confirm: true`. `restore_memory` reverses either.
- `list_memories` / `list_memory_events` — current state and audit log.
- `info_system` / `list_scopes_system` / `list_tags_system` — discover what the store contains.
- `list_conflicts` / `resolve_conflict` — conflict triage; surface to the user, do not auto-resolve.
- `list_config` / `get_config` / `set_config` — these are operator knobs; do not call them on the user's behalf unless asked.

## The session ritual

Three calls, in order, frame every session that involves durable knowledge.

### 1. At the start of a task — load context

Call `get_memory_context` with no arguments. The server returns a ranked set of relevant memories using confidence × recency × scope × pinned-status × confirmation-frequency. You do not need to know what to search for — that is the whole point of this tool.

If the response looks thin and you have a specific topic the user just mentioned (a project name, a tool name, "preference for X"), follow up with `search_memory` to deepen recall.

Loading a memory into context is **not** the same as using it. Do not call `confirm_memory` here — the decay engine relies on this distinction.

### 2. While you work — confirm what you actually use

When you rely on a memory to answer a question, shape a code change, pick between options, or set tone, call `confirm_memory` with that memory's id. This resets its decay timer; it tells the system "yes, this is still true and useful."

If you loaded a memory speculatively and did not end up using it, do not confirm it. Lying to the decay engine makes ranking worse over time, which hurts every future session — including this user's next one.

### 3. Before you wrap up — extract what surfaced

Call `extract_memory` with a batch of candidates for anything durable that came up in the conversation but was not explicitly written. The server dedups against existing memories using embedding similarity, scrubs secrets, and writes the survivors with lower default confidence (so unconfirmed extractions decay faster than direct user statements).

When in doubt, include the candidate. The server is the gatekeeper, not you.

## What to write — and what not to

**Write** durable assertions about the user, their preferences, their tools, their conventions, their projects, or their decisions:

- "Raghu prefers pnpm over npm for Node projects."
- "The staging cluster lives at gke-staging in us-central1."
- "Raghu writes in British English."
- "Decision: SQLite as the storage engine. Rationale: single-file, no daemon, FTS5 built in." (kind=`decision`, with rationale)
- "Snippet: the canonical way to read a Memento memory by id is `memento read <id>`." (kind=`snippet`, language=`shell`)

**Do not write** transient context:

- The file currently being edited.
- The error message that just appeared.
- A summary of what the user typed five minutes ago.
- The contents of a doc you both just looked at.
- "We are now starting a session" or any other meta-commentary.

Memento is a memory layer, not a chat log. Confusing the two ruins the signal: the store fills with noise that drowns out real preferences and decisions.

**Never write** secrets, tokens, API keys, passwords, or credentials. The built-in scrubber catches common shapes (sk-..., AKIA..., JWTs, etc.), but it is best-effort and not a vault. If the user pastes a credential and asks you to remember it, decline and suggest their password manager.

## Choosing a kind

Every memory has one of five kinds. Pick the one that best describes the assertion's role; the system uses kind to set decay half-life, ranking weights, and conflict semantics.

- `fact` — an assertion about the world, the codebase, or the user's situation. Default if you are unsure.
- `preference` — a user preference that should bias future actions. Includes work-style ("tabs over spaces"), tool ("pnpm over npm"), and writing-style ("concise over verbose") preferences.
- `decision` — a chosen path among alternatives, with a `rationale` explaining "why not the others." Architectural choices, technology picks, naming conventions the user had to defend.
- `todo` — an action item with an optional `due` timestamp. Use sparingly — Memento is not a task tracker. Useful for "ask about X next time."
- `snippet` — a reusable code fragment, with an optional `language` for syntax-aware retrieval.

If you find yourself reaching for `fact` for almost everything, that is fine — the taxonomy is for ranking, not classification rigor. Switch only when the kind genuinely changes the right behaviour (e.g. a `decision` decays slower than a `fact`, which is correct: architectural decisions should outlive incidental facts).

## Choosing a scope

Scope answers "where does this memory belong?" Pick the **narrowest** scope where the memory is durably true. The reader sees broader scopes too via layered effective reads, so erring narrow is safe — the user will still see global preferences inside a repo context.

- `global` — applies everywhere ("Raghu prefers concise summaries"). Cross-project preferences live here.
- `workspace` — pinned to a filesystem path. Use when there is no git remote, or when the project is intentionally off-VCS.
- `repo` — pinned to a canonical git remote ("this repo uses Apache-2.0"). The default for codebase facts.
- `branch` — pinned to a remote+branch pair. Use for in-flight work that should not leak to other branches.
- `session` — ephemeral, cleared when the MCP server restarts. Use for working memory you do not want to persist.

Two helpers reduce guessing:

- Call `list_scopes_system` to discover which scopes the user already has memories in.
- If the response is empty, default to `{"type":"global"}` — the safest broad scope.

For a `repo` scope, never invent the remote. Either ask the user, read it from their environment, or fall back to `workspace` / `global`. A wrong scope is a leak.

## Changes of mind: supersede, do not update

If the user changes their mind about something durable ("actually, switched from pnpm to bun"), call `supersede_memory` with the old memory's id and a new memory describing the current state. Both rows are preserved and linked; the audit log retains the history of what the user used to believe.

`update_memory` does **not** let you change content — its schema rejects content edits and points you at supersede in the error message. `update_memory` mutates only `tags`, `kind`, and `pinned`. This restriction is intentional: history is the whole point of having an audit log.

## Forgetting and archiving

Both are reversible (memories move to `forgotten` / `archived` status, never hard-deleted) but require `confirm: true` in the input — the schema rejects calls without it.

- `forget_memory` — "the user said this in error" or "this is no longer relevant."
- `archive_memory` — "this is historical and should not surface in default queries."
- `restore_memory` — reverses either.

Bulk variants (`forget_many_memories`, `archive_many_memories`) default to `dryRun: true` so a generous filter rehearses without mutating. Always preview before you apply, and show the matched count to the user before flipping `dryRun: false`.

## Conflicts: surface, do not resolve

Memento detects conflicts asynchronously after every write. They land in `list_conflicts`. If a write you make produces a conflict notice, do **not** retry the write or attempt to auto-resolve. Tell the user that the new information disagrees with an existing memory, show both, and ask which one to keep. The user resolves via `resolve_conflict` (or by giving you the answer in chat, in which case you call `resolve_conflict` on their behalf with the resolution they chose).

This is the deliberate "slow down here" surface in Memento. It exists because two writes can quietly disagree and silently overwriting one with the other ruins the audit trail that makes the system trustworthy.

## Sensitive content

If a memory contains personally-identifying notes the user wants kept but redacted from default search/list output, set `sensitive: true` on the write. The flag is a projection control: full content still embeds, indexes, and ranks normally; it just does not splash into search snippets unless the user explicitly fetches the row by id via `read_memory`.

`sensitive` is **not** a vault. Do not use it for secrets, tokens, or credentials — those should not be in Memento at all.

## A worked end-to-end example

User: *"Remember that I always prefer pnpm over npm for Node projects."*

You:

1. Call `write_memory` with `{"scope":{"type":"global"},"kind":{"type":"preference"},"tags":["tooling","node"],"content":"Raghu prefers pnpm over npm for Node projects."}`.
2. Reply briefly in chat: "Got it — saved as a global preference."

User: *"What was that I said earlier about my preferred CSS framework?"*

You:

1. Call `search_memory` with `{"text":"css framework preference"}`.
2. If a hit comes back, call `confirm_memory` with its id.
3. Tell the user the answer.

User: *"Actually, I switched from Tailwind to vanilla CSS — too much abstraction."*

You:

1. Call `search_memory` to find the prior preference; note its id.
2. Call `supersede_memory` with `{"oldId":"<that id>","next":{"scope":{"type":"global"},"kind":{"type":"preference"},"tags":["css"],"content":"Raghu prefers vanilla CSS over Tailwind. Reason: Tailwind feels like too much abstraction.","pinned":false,"summary":null,"storedConfidence":1}}`.
3. Confirm in chat.

End of session, before you sign off:

1. Call `extract_memory` with a batch of any durable claims that came up but were not explicitly remembered (the user mentioned they prefer Vitest, that the team uses Conventional Commits, that production runs on Postgres 15, etc.). The server dedups; you do not need to be precious.

## Why this matters

Every AI session starts the same way: re-explaining preferences, project conventions, decisions made last week, dead-ends to avoid. Memento exists so the user only says it once. Your job is to keep that promise: write what is worth remembering, recall it without being asked, confirm what you actually use, and surface contradictions instead of papering over them.

If the store stays empty, Memento is dead weight. If you write everything indiscriminately, you turn it into a chat-log dump that the user has to clean up. The middle path — distilled assertions, the right kind, the right scope, real confirmation signals, and explicit changes of mind — is what makes the system actually compound across sessions.

Be the assistant that, three months from now, knows the user without asking.
