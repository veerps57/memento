# Skills

This directory ships [Anthropic-format skills](https://docs.claude.com/en/docs/agents/skills) that improve how an AI assistant uses Memento. They are an additive distribution surface: Memento works without them, but installing the relevant skill closes the gap between "MCP server is wired up" and "the assistant uses memory well."

## Why skills live in this repo

The persona-snippet approach in [`docs/guides/teach-your-assistant.md`](../docs/guides/teach-your-assistant.md) is documentation: users have to find it, copy it, paste it into the right config file, and remember to update it when Memento's surface evolves. A skill bundle moves that knowledge into something the runtime actually reaches for — the assistant's client loads the skill on intent match, not on user discipline.

Shipping the skill from this repo (rather than a side channel) keeps the skill versioned with the code. When an ADR adds or changes a command, the matching skill update lands in the same PR. There is no parallel artefact to chase.

This is purely additive: the skill bundle does not change Memento's MCP/CLI surface, data model, dependencies, or load-bearing config defaults. No ADR is required (per [`AGENTS.md`](../AGENTS.md) §"Before you start a change"). Reviewers who want to understand the rationale can read this file.

## Available skills

| Name | Audience | What it does |
| --- | --- | --- |
| [`memento/`](memento/SKILL.md) | End users — any AI assistant talking to a user via MCP | Teaches the assistant when to write, recall, confirm, supersede, forget, and extract memories; how to choose scope and kind; how to handle conflicts and sensitive content. |

More to come — a `memento-dev` skill for AI agents working **on** the Memento codebase (encoding the 14 architectural rules, ADR cadence, and verification commands from [`AGENTS.md`](../AGENTS.md)) is queued.

## Installation

Skills are loaded by the AI client, not by Memento itself. The install path therefore depends on which client you use.

### Claude Code (and Cowork)

Copy the skill folder into your local skills directory. Claude Code's default location is `~/.claude/skills/`, but check your installation — some setups use a project-local `.claude/skills/` directory.

```bash
# from a clone of this repo
cp -R skills/memento ~/.claude/skills/

# or, if you only have a checkout via npm / npx
git clone --depth 1 https://github.com/veerps57/memento /tmp/memento-skills
cp -R /tmp/memento-skills/skills/memento ~/.claude/skills/
rm -rf /tmp/memento-skills
```

Restart your Claude Code session. The skill auto-loads on intent match — phrases like "remember that…", "what's my preferred…", "I changed my mind about…" should now route through Memento with no further configuration.

### Other MCP clients

Skills are an Anthropic-specific feature. For clients that do not support skills (Cursor, Cline, OpenCode, VS Code Agent mode, etc.), continue to use the persona snippet in [`docs/guides/teach-your-assistant.md`](../docs/guides/teach-your-assistant.md). The snippet's content mirrors what the skill teaches; the difference is delivery mechanism.

## Verifying it works

After installing the skill, start a fresh session and tell your assistant a durable preference:

> I prefer Vitest over Jest for new TypeScript projects.

The assistant should call `write_memory` (visible in the MCP tool-call inspector) with kind `preference` and a global or workspace scope. Without the skill, a stock assistant typically replies "Got it!" without persisting anything.

In a second session, ask:

> What's my preferred test runner?

The assistant should call `search_memory` or `get_memory_context`, find the preference, and answer — followed by a `confirm_memory` call to bump the memory's `lastConfirmedAt`.

If either step fails, the most likely causes are: the skill is not in the right directory for your client, the client cache needs invalidating (restart it), or your assistant's persona file is fighting the skill. `npx @psraghuveer/memento doctor` triages the MCP wiring; the skill itself is independent of the database.

## Authoring more skills here

When adding a new skill:

1. Create `skills/<skill-name>/SKILL.md` with YAML frontmatter (`name`, `description`).
2. The `description` is the trigger — be specific about phrasings, contexts, and proactive cases. See [`memento/SKILL.md`](memento/SKILL.md) for the pattern.
3. Add a row to the table above.
4. Cross-link from any guide in `docs/guides/` whose subject the skill subsumes.
5. Use [Anthropic's skill-creator workflow](https://docs.claude.com/en/docs/agents/skills) to test the skill against realistic prompts before merging.
