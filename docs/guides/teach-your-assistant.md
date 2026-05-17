# Teach your assistant

Memento exposes a set of MCP tools (`write_memory`, `search_memory`, `confirm_memory`, `get_memory_context`, etc.) but it does not, by itself, teach an AI assistant *when* to use them. That part is up to you.

There are three teaching surfaces, in priority order. **You only need the first one** — the others are enrichment for clients that load them.

## 1. Server-emitted `instructions` (every client, automatic) — ADR-0026

Memento's MCP server returns a ~60-line `instructions` string on the `initialize` handshake. Every spec-compliant MCP client (Claude Code, Claude Desktop, Cursor, VS Code Agent, OpenCode, Cline, …) injects this string into the assistant's system prompt verbatim, with no user action. You wired this when you pasted the MCP-server snippet from `memento init`.

The spine covers the session-start contract: when to load context, when to write, when to confirm, when to supersede, the `topic: value` first-line rule, the silent-plumbing rule, and the secrets prohibition. If your client honours the field, your assistant already has the contract. The canonical text lives in [`packages/server/src/instructions.ts`](../../packages/server/src/instructions.ts) — operators who want to override it can pass `info.instructions` when constructing the server, or prepend / append their own addendum via string concatenation.

## 2. The bundled skill (Anthropic-format clients, on-intent) — load-on-demand enrichment

If your AI client loads [Anthropic-format skills](https://docs.claude.com/en/docs/agents/skills), install [`skills/memento/`](../../skills/memento/SKILL.md). The skill carries the deeper distillation curriculum — named-participant attribution, dated-event capture, precursor-action capture, kind / scope decision trees, the worked end-to-end example — that does not need to load every session. `memento init` will prompt to install the skill into `~/.claude/skills/` interactively; you can also run `cp -R "$(npx -y @psraghuveer/memento skill-path)" ~/.claude/skills/` by hand. Most skill-capable clients read from `~/.claude/skills/<name>/SKILL.md`; a few use a client-specific path (check your client's skill docs and re-target the install if the skill doesn't pick up after a restart). See [`skills/README.md`](../../skills/README.md) for install detail.

## 3. The persona snippet (last resort, clients that load neither) — manual paste

A handful of clients honour neither the MCP `instructions` field nor Anthropic-format skills. For those, the persona snippet below is the supported alternative. Paste it into the client's persona file (`CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`, OpenCode prompt, custom system prompt). It mirrors the spine — kept here so you can paste-and-forget rather than discovering the rules empirically.

The fragments below are deliberately short and opinionated. Adapt them to your usage.

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

### Preserve specific terms — don't paraphrase qualifiers away

"Distilled, not transcript" doesn't mean "summarised into generic categories." You are not summarising for a reader — you are producing retrieval candidates for unknown future queries. The future question uses the specific terms the speaker used; an assistant that drops them blocks recall.

```text
You are not summarising the conversation. You are producing
retrieval candidates for unknown future queries — the future
question may ask about any specific date, named entity, proper
noun, action, or object that came up. Index every concrete
reference; don't capture the gist.

Preserve specific words. Use the speakers' exact terms for proper
nouns, named entities, identity qualifiers, places, dates, and the
specific object of any action.

- "researched adoption agencies" → "Raghu researched adoption
  agencies", not "Raghu researched career options".
- "transgender woman" → "Raghu is a transgender woman", not
  "Raghu identifies as a woman".
- "the Wonderland Trail" → name it, not "a hiking trail".
- "May 7" → resolve to an absolute date and emit it, not
  "in spring".

Capture facts about every named participant, not only the user.
A conversation may mention or include other people — a friend the
user talks about, a colleague, a family member, or a co-speaker in
a shared session. Facts they share about themselves AND the user's
specific observations about them are both worth indexing, each
attributed to the right named person.

- "My friend Alex is moving to Berlin next month for a SAP job"
  → emit "Alex is moving to Berlin in <month>" AND "Alex has a
  new job at SAP" (attributed to Alex, not collapsed to Raghu).
- In a meeting transcript where Sarah said "I have three kids"
  and Raghu said "I work from home" → both facts get captured,
  each attributed to its speaker. Don't bias toward the first
  speaker or the apparent "user" persona.

Emit a candidate for every dated event. If the user mentions an
event with a resolvable date — absolute ("May 7") or relative
("yesterday", "last Tuesday", "two weeks ago") — emit one
candidate with the absolute date in the content. Resolve relative
dates against the current date. Do NOT generalise dated events
into untimed habits ("the user attends conferences" loses the
date). When in doubt, emit both a dated candidate AND a general
one. The future "when did X happen?" question can only be
answered by a memory that names the date.

Capture precursor actions alongside outcomes. When the user
describes a sequence ("researched X then chose Y", "tried A and
settled on B"), emit both: a candidate for the precursor (the
research, the try) AND a candidate for the outcome. Future
questions can target either step — "what did Raghu research?"
and "what did Raghu choose?" have different answers.

Don't squash enumerations. If the user lists four activities,
emit four facts (or one fact that names all four explicitly) —
never one fact that says "outdoor activities and crafts".

Bias toward inclusion. The server dedups via embedding
similarity; over-including is cheap, under-including drops the
fact entirely.

Before finalising a write_memory or extract_memory call, scan the
conversation once more: every date or time-relative word, every
proper noun, every action verb with a specific object — does each
map to at least one candidate? If a reference is missing, add it.
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
  configuration is `auto` (ADR-0027): batches of ≤10 candidates
  run sync (the response arrays are authoritative); larger
  batches go async (response arrays empty, work lands in
  ~1–5 s). The `mode` field on the response discriminates.
- `write_memory` and `extract_memory` share one candidate shape
  (ADR-0027): `kind` is a discriminated-union object, with
  per-kind fields nested inside. Use
  `{"type":"fact"}`, `{"type":"preference"}`,
  `{"type":"decision","rationale":"..."}`,
  `{"type":"todo","due":null}`,
  `{"type":"snippet","language":"shell"}`.
- For preferences and decisions, start `content` with a single
  `topic: value` line followed by prose. Conflict detection
  parses that line; the server rejects offending writes with
  `INVALID_INPUT` (governed by `safety.requireTopicLine`,
  default true).
- Distillation is **retrieval indexing**, not summarisation. The
  future question may ask about any specific date, named entity,
  proper noun, action, or object that came up — index every
  concrete reference, don't capture the gist.
- Preserve specific terms when distilling. Use the speakers' exact
  words for proper nouns, identity qualifiers, places, dates, and
  the object of any action. "Raghu researched adoption agencies",
  not "researched career options". "Transgender woman", not
  "woman". Don't squash enumerations; emit each item or list them
  explicitly. When in doubt, include — the server dedups.
- Capture facts about every named participant, not only the user.
  If the user mentions someone ("my friend Alex is moving to
  Berlin for a SAP job"), emit memories attributed to that named
  person (Alex is moving to Berlin; Alex has a new job at SAP),
  not collapsed onto the user. The future question may ask about
  anyone named in the conversation.
- Emit a candidate for every dated event. If the user mentions an
  event with an absolute date ("May 7") or a relative one
  ("yesterday", "last Tuesday"), resolve to an absolute date and
  emit it in the content. Don't fold dated events into untimed
  habits — the future "when did X happen?" query can only be
  answered by a memory that names the date.
- Capture precursor actions alongside outcomes. When the user
  describes a sequence ("researched X then chose Y", "tried A and
  settled on B"), emit both — a candidate for the precursor and a
  candidate for the outcome. Future questions can target either
  step; the outcome never erases the precursor.
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
