# Architecture: Scope Semantics

Scope answers the question "where does this memory belong, and when is it visible?" It is the most-asked design question about Memento, so it gets its own document.

## The five scopes

```ts
type Scope =
  | { type: "global" }
  | { type: "workspace"; path: AbsolutePath }
  | { type: "repo"; remote: RepoRemote } // canonicalized git remote URL
  | { type: "branch"; remote: RepoRemote; branch: string }
  | { type: "session"; id: SessionId };
```

Each scope answers a different question:

| Scope       | Lives until             | Typical use                                               |
| ----------- | ----------------------- | --------------------------------------------------------- |
| `global`    | The user deletes it     | Personal preferences, cross-project conventions           |
| `workspace` | The folder is deleted   | Local environment quirks, machine-specific paths, project-specific context |
| `repo`      | The repo is forgotten   | Project-level facts, conventions, team decisions          |
| `branch`    | The branch is forgotten | Work-in-progress decisions tied to a feature branch       |
| `session`   | The session ends        | Ephemeral working memory; cleared when the agent restarts |

**Note on non-git domains.** `repo` and `branch` scopes are git-specific and require a git remote to resolve. Workflows without a git remote — writing, research, planning, personal knowledge management, or any project not under version control — use `global`, `workspace`, and `session` scopes. The `workspace` scope is the most natural fit for project-level context that isn't tied to a git repository — e.g., a research folder, a writing project directory, or a client engagement workspace.

`workspace` and `repo` are deliberately separate: a workspace can contain multiple repos (monorepo), and a repo can be checked out in multiple workspaces. They answer different questions.

## Scope resolver

`ScopeResolver` is composed of three pure resolvers:

```text
┌──────────────────────┐
│ WorkspacePathResolver│  → workspace path from cwd
└──────────────────────┘
┌──────────────────────┐
│ GitRemoteResolver    │  → canonical remote URL + current branch
└──────────────────────┘
┌──────────────────────┐
│ SessionResolver      │  → ephemeral session id (per server process)
└──────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────┐
│ ScopeResolver (composite, thin policy layer) │
└──────────────────────────────────────────────┘
```

Each underlying resolver is a pure function over (cwd, env, git state) and individually testable. The composite layers them according to configurable policy. This is principle 2 (Modular) in code: any resolver can be swapped for tests, and adding a new scope dimension means adding one resolver, not rewriting the composite.

### Git remote canonicalization

`GitRemoteResolver` canonicalizes remote URLs so that `git@github.com:org/repo.git`, `https://github.com/org/repo`, and `https://github.com/org/repo.git` all resolve to the same `repo` scope. The canonical form is documented in the resolver's tests; an ADR may pin it explicitly if disagreement arises.

If the cwd is not in a git repo, `GitRemoteResolver` returns `null`. `repo` and `branch` scopes are unavailable; `workspace`, `global`, and `session` still work.

## Write-time scope is explicit

When a caller writes a memory, the scope is part of the call. There is no implicit "current scope" the server picks. This is deliberate: the agent should commit to a scope choice, and the scope choice should appear in the audit log.

There is no workspace-scaffolding command. Callers pass `scope` explicitly on every write, or set a workspace default in their MCP client config (see [KNOWN_LIMITATIONS.md](../../KNOWN_LIMITATIONS.md)).

`pack.install` ([ADR-0020](../adr/0020-memento-packs.md)) is a special case of this: the manifest declares a `defaults.scope` that applies to every memory in the pack, and the install caller may override it via the `scope` input. A pack manifest is single-scope by construction — `PackMemoryItem` has no per-item scope field — so installing a pack into the wrong scope is an explicit override at install time, not a per-memory accident.

## Read-time scope is layered

When a caller reads (`memory.search`, `memory.list`), they pass an optional `scopes: Scope[]` filter:

- **Omit it** — the read targets the layered effective set (session ⊕ branch ⊕ repo ⊕ workspace ⊕ global) computed by the resolver from the current cwd, git state, and session id. This is the common case.
- **Pass an explicit array** — only those scopes contribute candidates.

Layering means a `repo` memory and a `global` memory both surface for the same query, with the more-specific scope ranked slightly higher (configurable per-level via `retrieval.scopeBoost`).

### Why layered, not strict

A user's preference about commit message style (global) and a repo's convention about commit message style (repo) are both relevant; neither subsumes the other. Strict scope precedence ("repo wins, global ignored") would silently hide useful context. Layering surfaces both and lets the ranker decide.

The boost is configurable rather than hardcoded because workflows differ: in a strict-conventions monorepo, repo memories should dominate; for a solo practitioner, global memories should dominate. Same code, different config.

## Scope is immutable

Once written, a memory's scope cannot be changed. This is consistent with `id`, `createdAt`, and `schemaVersion`: identity is set at creation and preserved.

To "move" a memory between scopes, the caller writes a new memory in the target scope and supersedes the original. The audit log preserves both, and queries against the original scope correctly return the superseded marker.

This rule eliminates an entire class of bugs: there is no way for a memory to be in two scopes at once, no way for a scope-rewrite to silently corrupt the layered read path, and no way for the audit log to lie about where a memory has lived.

## Session scope

Session scope is unique: it is created lazily on first use and bound to the lifetime of the MCP server process. When the process exits, session memories are not deleted but become unreachable from the resolver (they remain in the audit log).

`session.id` is a ULID generated at server start. It is stable for the duration of the process so that an agent can write and then re-read its own working memory within a session.

## What this enables

- **Per-repo onboarding.** `memento export --scope=repo:<remote>` produces a portable artifact a new contributor can `memento import` to bootstrap their assistant's memory.
- **Branch-isolated experimentation.** A wild design idea on `feat/x` does not leak into `main`'s effective view.
- **Ephemeral scratch space.** Session memories let agents track work-in-progress without polluting durable memory.

## What this deliberately does not support

- **Cross-machine sync.** Scope is local to the machine. Sync is out of scope.
- **Org / team scope.** `OwnerRef` is the extension point; the data model is ready, commands are not.
- **Scope inheritance trees.** Layering is flat (session/branch/repo/workspace/global). Arbitrary nesting is unbounded modeling and is not justified yet.
