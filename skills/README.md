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
| [`memento-dev/`](memento-dev/SKILL.md) | Contributors to the Memento repo (human or AI) | Encodes the four guiding principles, the 14 architectural rules, ADR cadence, the verification chain, common pitfalls, and the workflows for adding commands / config keys / migrations. |

## Installation

Skills are loaded by the AI client, not by Memento itself. The install path depends on which client you use, **and on which skill you are installing** — `memento` is for end users of any AI assistant, `memento-dev` is for contributors editing this repo.

### End users: the `memento` skill (Claude Code, Cowork)

The fastest path is to let `memento init` print the exact copy command for your install:

```bash
npx @psraghuveer/memento init
```

Look for the **"Memento skill"** section in the output. It includes a `mkdir -p` and `cp -R` line you can copy-paste verbatim — `init` resolves the source path against wherever the package actually landed (npx cache, global install, or a clone), so the command works in every install layout.

Then restart your Claude Code session. The skill auto-loads on intent match — phrases like "remember that…", "what's my preferred…", "I changed my mind about…" should now route through Memento with no further configuration.

If you'd rather do it by hand from a clone:

```bash
cp -R skills/memento ~/.claude/skills/
```

Claude Code's default skills location is `~/.claude/skills/`, but check your installation — some setups use a project-local `.claude/skills/` directory.

#### Updating after a Memento upgrade

The installed copy at `~/.claude/skills/memento/` does **not** auto-refresh when you bump the Memento package. After every upgrade — `npm i -g @psraghuveer/memento`, a new `npx` cache, or a clone update — re-run `memento init` and re-paste the install command (or re-`cp` from your clone) to pick up the latest skill instructions. `memento init` is idempotent; the second run just reprints.

### Contributors: the `memento-dev` skill (Claude Code only)

If you have a clone of this repo and you use Claude Code, install the contributor skill so the four guiding principles, the 14 architectural rules, the verification chain, and the common pitfalls auto-load on intent match for any change you make under `packages/`:

```bash
cp -R skills/memento-dev ~/.claude/skills/
```

Restart Claude Code. The skill triggers on prompts like "add a command", "add a config key", "add a migration", "open an ADR", or any edit under `packages/`. It deliberately does **not** trigger when you are merely *using* Memento as a dependency in another project — the trigger description checks for the repo-root markers (`AGENTS.md` plus the `packages/` layout) before firing.

`memento init` does **not** print a snippet for this skill — it is a contributor tool, not an end-user one. Install once per machine; `git pull` updates the in-repo copy, but you must re-`cp` to pick up changes. (Skill content rarely shifts.)

#### Verifying the dev skill auto-triggers

Open a fresh Claude Code session inside this repo and ask:

> What's the rule about hardcoded behavioral constants?

The skill should fire and the assistant should answer with rule 2 (no hardcoded behavioral constants — every behavioral knob is a `ConfigKey`). If it doesn't, the skill is either not in `~/.claude/skills/memento-dev/` or the client cache needs invalidating (full restart, not just a new chat).

### Other MCP clients

Skills are an Anthropic-specific feature. For clients that do not support skills (Cursor, Cline, OpenCode, VS Code Agent mode, etc.), continue to use the persona snippet in [`docs/guides/teach-your-assistant.md`](../docs/guides/teach-your-assistant.md). The snippet's content mirrors what the `memento` skill teaches; the difference is delivery mechanism. There is no equivalent contributor surface for non-skill clients today — `AGENTS.md` is the canonical document, and contributors using non-skill clients should read it before opening a PR.

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
