# @psraghuveer/memento-server

## 0.4.1

### Patch Changes

- 9a158fd: feat(cli): auto-install the persona snippet into detected clients; client-neutral docs reframe

  Two coupled changes shipping together. The reframe (docs + init walkthrough) acknowledges what testing showed — the MCP `instructions` field (ADR-0026) is optional on the client side and current implementations typically don't surface it to the assistant's system prompt. The new auto-installer collapses the manual "paste this into your client's custom-instructions slot" step into a `y/N` during `memento init` for the subset of clients whose persona slot is a file on disk.

  **Auto-installer (new `packages/cli/src/persona-installer.ts`)**

  A fourth interactive prompt in `memento init` offers to write the persona snippet — sourced from the same `MEMENTO_INSTRUCTIONS` constant the MCP server emits — into every detected file-based client's user-scope custom-instructions file. UI-only clients (Cowork, Claude Desktop, Claude Chat, Cursor User Rules) surface as copy-paste instructions in the renderer.

  Detected targets, by canonical user-scope path:

  - Claude Code → `~/.claude/CLAUDE.md` (loaded into every session per Anthropic's docs)
  - OpenCode → `~/.config/opencode/AGENTS.md`
  - Cline → `~/Documents/Cline/Rules/memento.md`

  Each write is wrapped in HTML-comment markers (`<!-- memento:persona BEGIN v<version> -->` / `<!-- memento:persona END -->`), making the install:

  - **Idempotent.** Re-running `init` with identical content reports `already-current` and no-ops the write.
  - **Updatable in place.** Re-running with new content splices the block out and rewrites — no accumulated drift, no duplicate blocks.
  - **Removable.** The marker bounds let a future `memento persona uninstall` strip the block while leaving surrounding user content intact.

  Detection is filesystem-only — no network calls. A client whose canonical directory doesn't exist on the host is simply skipped (no write, no spurious "if you also use X…" line). The persona content itself reuses `MEMENTO_INSTRUCTIONS` exported from `@psraghuveer/memento-server` so the spine on the wire and the persona on disk never drift.

  The prompt defaults to `Y` and presents an explicit per-target enumeration before asking for consent — the user sees exactly which files will be written and which UI surfaces still need manual paste before confirming.

  **Docs + walkthrough reframe (client-neutral)**

  Every user-facing doc reordered into reliability order — persona first, skill second, spine third — with all client-specific honours/doesn't claims removed. The framing now is:

  - **Persona snippet** = universal, always-on. The only teaching surface guaranteed to land in every client. **Now optionally auto-installed** during `memento init` for file-based clients.
  - **Bundled skill** = load-on-intent enrichment for skill-capable clients.
  - **MCP `instructions` spine** = best-effort future-proofing on the wire. Optional on the client side; implementations vary.

  Files touched (docs + init prose):

  - Root `README.md`, `packages/cli/README.md`, `packages/server/README.md` — three-step quickstart; spine framed as best-effort future-proofing.
  - `docs/guides/teach-your-assistant.md` — surfaces reordered into reliability order; the per-client honours/doesn't matrix removed in favour of neutral single-paragraph framing per surface.
  - `packages/landing/src/App.tsx` + `howto.ts` — quickstart grid expands to three cards; persona snippet block re-titled "the universal always-on teaching surface".
  - `docs/adr/0026-mcp-instructions-as-session-teaching-spine.md` — prose updates; the decision is unchanged. ADR-immutability protects the decision, not the wording.
  - `packages/cli/src/init-render.ts` — Step 3 now opens with the universal persona recommendation; per-target persona-install outcomes render below the existing skill / pack ack block.

  Language is client-neutral throughout — no surface is labelled by which specific clients honour it.

  **Bump rationale**

  - `@psraghuveer/memento` (CLI): **minor** — coherent feature addition (auto-installer) on top of the docs sweep.
  - `@psraghuveer/memento-server`: **patch** — docs-only changes; no behaviour change.

  `pnpm verify` clean. **1612 tests passing** across 118 files (+12 new persona-installer tests on top of the 1600 baseline).

## 0.4.0

### Minor Changes

- c0433c2: Onboarding revamp: spec-compliant session teaching, unified memory write surface, interactive `init`, and a new `verify-setup` command.

  This is a coordinated 0→1 install-journey overhaul shipping across every published package.

  **What's new**

  - **MCP `instructions` on every connect** (ADR-0026). `buildMementoServer` now emits a ~60-line session-start teaching spine as part of the `initialize` handshake. The MCP spec leaves `instructions` optional on the client side and current client implementations vary in whether they surface it to the assistant's system prompt — treat the spine as best-effort future-proofing on the wire. The persona snippet (paste-into-custom-instructions; auto-installed by `memento init` for detected file-based clients in a follow-up release) is the universal always-on teaching surface; the bundled skill is on-intent enrichment for skill-capable clients. The canonical spine body is exported as `MEMENTO_INSTRUCTIONS` from `@psraghuveer/memento-server`; operators can override via `info.instructions`.
  - **Unified `memory.write` / `memory.extract` candidate shape** (ADR-0027). Both surfaces now take the same discriminated-union `kind` object: `{"type":"fact"}`, `{"type":"preference"}`, `{"type":"decision","rationale":"..."}`, `{"type":"todo","due":null}`, `{"type":"snippet","language":"shell"}`. Per-kind fields (`rationale`, `language`) live inside the `kind` object, not as top-level siblings. **Breaking change to `memory.extract`** — callers that hand-construct extract payloads with the flat-`kind` shape (`{"kind":"fact","rationale":"..."}`) must migrate to nested form. The bundled packs and the skill ship with the new shape; the persona snippet is updated; the tool descriptions in `tools/list` spell it out.
  - **Hybrid sync/async `memory.extract`**. New default `extraction.processing: 'auto'` runs sync for batches ≤ `extraction.syncThreshold` (default 10) and async above. The "empty-arrays receipt looks like a failure" UX is gone for typical session-end sweeps. The explicit `sync` and `async` overrides remain for operators with strict requirements.
  - **Interactive `memento init`** (ADR-0028). On a TTY, `init` walks the user through three one-keystroke setup questions before printing the MCP snippets: their preferred display name (so memories read "Raghu prefers …" not "The user prefers …"), whether to install the bundled skill into `~/.claude/skills/`, and whether to seed the store with one of four starter packs. Pass `--no-prompt` to suppress the interactive flow (CI, scripts). The walkthrough text trims itself accordingly — sections whose work is done don't reappear as copy-paste instructions.
  - **New `memento verify-setup` command** (ADR-0028). End-to-end MCP write/search/cleanup round-trip that proves your assistant can actually use Memento. Runs against the same engine surface `memento serve` exposes via an in-memory MCP transport — no subprocess spawn. Replaces the previous "ask the assistant something and see if it works" smoke test with a structured check sequence.

  **Topic-line enforcement is now the documented default**. `safety.requireTopicLine` already defaulted to `true`; this PR ratifies the rule in the persona snippet, the skill, the spine, and the READMEs as binding rather than opt-in. Existing flag-flip (`safety.requireTopicLine: false`) remains for operators who want the historical permissive shape.

  **Migration**

  If you hand-construct `memory.extract` payloads (custom agents, scripts, third-party packs not authored against `@psraghuveer/memento`):

  ```diff
  - { "kind": "decision", "rationale": "FTS5 + single file", "content": "..." }
  + { "kind": { "type": "decision", "rationale": "FTS5 + single file" }, "content": "..." }

  - { "kind": "snippet", "language": "shell", "content": "memento init" }
  + { "kind": { "type": "snippet", "language": "shell" }, "content": "memento init" }

  - { "kind": "fact", "content": "..." }
  + { "kind": { "type": "fact" }, "content": "..." }
  ```

  Everything else is additive — interactive `init` falls back to print-only behaviour on a non-TTY or with `--no-prompt`, and the MCP `instructions` field is silently ignored by any (non-spec-compliant) client that doesn't honour it. No data-migration required.

### Patch Changes

- Updated dependencies [c0433c2]
  - @psraghuveer/memento-core@0.16.0
  - @psraghuveer/memento-schema@0.13.0

## 0.3.9

### Patch Changes

- Updated dependencies [96a62f0]
  - @psraghuveer/memento-core@0.15.0

## 0.3.8

### Patch Changes

- Updated dependencies [c430d82]
  - @psraghuveer/memento-core@0.14.0
  - @psraghuveer/memento-schema@0.12.1

## 0.3.7

### Patch Changes

- Updated dependencies [ab0eca1]
  - @psraghuveer/memento-core@0.13.0
  - @psraghuveer/memento-schema@0.12.0

## 0.3.6

### Patch Changes

- Updated dependencies [0dc4716]
  - @psraghuveer/memento-schema@0.11.0
  - @psraghuveer/memento-core@0.12.0

## 0.3.5

### Patch Changes

- Updated dependencies [af104e5]
  - @psraghuveer/memento-core@0.11.0
  - @psraghuveer/memento-schema@0.10.0

## 0.3.4

### Patch Changes

- Updated dependencies [7ebe1c6]
  - @psraghuveer/memento-core@0.10.0
  - @psraghuveer/memento-schema@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [65e49d3]
  - @psraghuveer/memento-core@0.9.0
  - @psraghuveer/memento-schema@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [5479c6a]
  - @psraghuveer/memento-core@0.8.0
  - @psraghuveer/memento-schema@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [1dc5f71]
  - @psraghuveer/memento-core@0.7.0
  - @psraghuveer/memento-schema@0.6.0

## 0.3.0

### Minor Changes

- a83c2c0: End-to-end security hardening pass before public launch. Findings from a full-codebase audit (DoS surface, scrubber correctness, import/export trust boundaries, dashboard auth, storage hygiene, install supply-chain) addressed in code, with regression tests and updated docs. Defaults are conservative — every behaviour change is either rejecting input that was already a DoS or bypass risk, or a new opt-in. Functional behaviour on the happy path is unchanged.

  **Scrubber correctness** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`)

  - Now scrubs `summary` and (for `decision`-kind memories) `kind.rationale` in addition to `content`. Earlier the scrubber operated on `content` only — an LLM auto-generating a summary from raw content trivially round-tripped secrets into the persisted summary, defeating the whole defence.
  - Two new default rules: `private-key-block` (PEM private-key blocks) and `bearer-token` (HTTP `Authorization: Bearer …`). Previously claimed in `SECURITY.md` but missing from the code.
  - Email regex rewritten to be ReDoS-safe (split the domain into non-overlapping label classes); JWT regex tightened to admit real-world short payloads.
  - New `scrubber.engineBudgetMs` ConfigKey (default 50 ms) caps each rule's wallclock runtime; aborts a runaway operator-installed regex without blocking the writer thread.
  - `scrubber.enabled` and `scrubber.rules` flipped to immutable at runtime (`mutable: false`). A prompt-injected MCP `config.set` can no longer disable redaction before writing a secret. `IMMUTABLE` error fires regardless of which surface invoked the command.

  **Import re-stamp policy** (`@psraghuveer/memento-core`, ADR-0019)

  `memento import` no longer trusts caller-supplied audit claims. Three transformations always happen on every imported artefact, regardless of flags:

  1. `OwnerRef` rewritten to local-self (closes the future-multi-user owner-spoofing vector at the wire boundary; AGENTS.md rule 4).
  2. Memory `content` / `summary` / `decision.rationale` re-scrubbed using the **importer's** current rule set. An artefact authored on a host with a weaker scrubber has its secrets re-redacted on arrival.
  3. `MemoryEvent.payload`, `Conflict.evidence`, and `ConflictEvent.payload` JSON capped per record at 64 KiB. A forged artefact cannot stuff multi-megabyte audit-log blobs.

  On top of those, the new `--trust-source` flag controls the audit chain. Default (flag absent): the source artefact's per-memory event chain is collapsed into one synthetic `memory.imported` event per memory; `actor` and `at` reflect the importer, not the source. With `--trust-source`: original events are inserted verbatim — for the "I am restoring my own backup, preserve the history" case. The `imported` variant is added to `MEMORY_EVENT_TYPES` and migration `0006_memory_events_imported_type.ts` widens the SQLite CHECK constraint to admit it.

  **Resource caps** (`@psraghuveer/memento-schema`, `@psraghuveer/memento-core`, `@psraghuveer/memento-server`, `@psraghuveer/memento-embedder-local`)

  A wire input that previously could OOM the process is now rejected with `INVALID_INPUT`. Every cap has a structural ceiling at the schema boundary plus an operator-tunable floor below it.

  - `memory.write`/`write_many`/`supersede`/`extract` content > 1 MiB rejected at the schema; `safety.memoryContentMaxBytes` (default 64 KiB) tightens at the handler. Companion caps: `safety.summaryMaxBytes` (2 KiB), `safety.tagMaxCount` (64).
  - New stdio transport wrapper enforces `server.maxMessageBytes` (default 4 MiB, immutable). A peer that withholds the trailing newline can no longer grow the JSON-RPC read buffer until Node OOMs.
  - Local embedder accepts `embedder.local.maxInputBytes` (default 32 KiB, immutable; UTF-8-safe truncation before tokenisation) and `embedder.local.timeoutMs` (default 10 s, immutable; `Promise.race` against the embed call).
  - `memento import` rejects artefacts larger than `import.maxBytes` (default 256 MiB) up-front via `fs.stat`, then streams the file via `readline.createInterface`. Multi-GB artefacts no longer OOM the CLI before parsing begins.

  **Dashboard hardening** (`@psraghuveer/memento-dashboard`, `@psraghuveer/memento-core`)

  The dashboard is the project's only network-bound surface. Three independent defence layers added:

  1. **Per-launch random token.** Every `memento dashboard` invocation mints a 256-bit token and embeds it in the URL fragment passed to the browser. The SPA reads it from `window.location.hash`, persists to `sessionStorage`, sends `Authorization: Bearer …` on every API call. Closes the "any local process can hit `127.0.0.1:<port>`" gap. Note: bookmarks of the dashboard URL no longer work — re-launch via `memento dashboard` to get a fresh token.
  2. **Origin guard now exact-port-matched** (was: prefix-match against any localhost). A sibling localhost web server (Vite dev server, another local app) can no longer forge requests against the dashboard.
  3. **Host-header allowlist** for DNS-rebinding defence: only `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` accepted.

  Plus: a new `'dashboard'` value on `CommandSurface`. Only commands the UI uses today are opted in (read paths + `memory.confirm`/`update`/`forget`, `config.*`, `conflict.list`/`resolve`); everything else (writes, supersede, set*embedding, archive variants, restore, *\_many, conflict.scan, embedding.rebuild, compact.run, memory.context, memory.extract, system.list*tags) returns `INVALID_INPUT` from the dashboard pointing at the CLI. Hono `secureHeaders` (CSP, X-Frame-Options DENY, nosniff, no-referrer); 4 MiB body limit on `/api/commands/*`; static handler now does realpath-based containment; sourcemaps no longer ship in production builds.

  **Storage and file hygiene** (`@psraghuveer/memento-core`, `@psraghuveer/memento`)

  - `pragma trusted_schema = OFF` in the canonical PRAGMA set. A user opening an attacker-supplied `.db` via `--db /tmp/evil.db` can no longer be hit by trigger-borne side effects.
  - DB files written with mode `0600`, data directory and embedder cache with mode `0700`. Memory content is operator-private even after scrubbing; permissive umasks no longer expose it on multi-user hosts.
  - `memento backup` now writes via tempfile + atomic rename (closes the existsSync→unlink→VACUUM TOCTOU), uses `VACUUM INTO ?` with a bound parameter (was: single-quote-escape interpolation), and produces a 0600 file.
  - `INTERNAL` and `STORAGE_ERROR` messages returned to MCP clients have absolute filesystem paths replaced with `<path>` (was: SQLite errors leaked `/Users/<name>/...` to the wire). Well-known messages (NOT_FOUND, CONFLICT) are preserved for actionable error UX.
  - `memento init`'s WAL/SHM/journal-sidecar cleanup now `lstat`s before unlink and refuses anything that isn't a regular file (closes the symlink-replacement footgun on shared `/tmp` paths).
  - `memento export` defaults to `flags: 'wx'` (refuse to clobber existing files), `mode: 0o600`. New `--overwrite` flag opts in.

  **Install / supply-chain hardening** (`@psraghuveer/memento`)

  - Both postinstall scripts now pass a closed env allowlist when invoking `npm`/`npx`. Drops `npm_config_script_shell`, `NODE_OPTIONS`, `PREBUILD_INSTALL_HOST`, every other `npm_config_*` env, etc. — closes the documented "malicious sibling dep stages env vars to subvert npm" supply-chain vector.
  - `npm`/`npx` resolved via `process.env.npm_execpath` (set by npm during install) instead of `PATH`. Avoids `node_modules/.bin/npm` hijack by a colluding dep with a `bin: "npm"` entry.
  - Embedder model cache moved from `node_modules/.../@huggingface/transformers/.cache/` to `$XDG_CACHE_HOME/memento/models` (or platform equivalent). Persistent across reinstalls, owner-private, and not plantable from `node_modules`. **First run after upgrade re-downloads the model (`bge-base-en-v1.5`, ~110 MB) into the new location.**
  - `memento doctor --mcp` JSON-parse failures report only the error class name, dropping byte-positional context (Node 22's SyntaxError can include surrounding-line bytes; some MCP client configs hold API tokens; doctor reports get pasted into bug reports).

  **Documentation**

  - New ADR: [ADR-0019 — Import re-stamp policy](docs/adr/0019-import-re-stamp-policy.md).
  - `SECURITY.md` rewritten — "Defenses Memento Provides" / "Does Not Provide" sections now match what the code delivers.
  - `KNOWN_LIMITATIONS.md` extended (dashboard token is per-launch; embedder cache moved to XDG).
  - `docs/architecture/{config,scrubber,data-model}.md` updated for new ConfigKeys, scrubber rules + summary/rationale coverage, the `imported` event variant.
  - `AGENTS.md` rules 4 and 11 cross-reference ADR-0019.
  - ADR-0012 marked as extended; the `safety.*` namespace now also carries the resource caps added in this pass.

  **Behaviour changes worth knowing**

  - Writes that were previously accepted but DoS-shaped (e.g. > 64 KiB content, > 4 MiB JSON-RPC message, multi-GB import) are now `INVALID_INPUT`. No legitimate workflow is affected; raise `safety.*` / `import.maxBytes` if your data exceeds the defaults.
  - `config.set scrubber.enabled` / `scrubber.rules` from MCP now returns `IMMUTABLE`. Set them at startup via configuration overrides instead.
  - `memento export` refuses to overwrite by default; pass `--overwrite` to keep the prior behaviour.
  - `memento dashboard` URLs include a token fragment; bookmarks of the URL won't authenticate on a future visit (re-launch to get a fresh URL).
  - First `memento dashboard` / vector-search after upgrade re-downloads the embedder model into the new XDG cache location.

### Patch Changes

- Updated dependencies [a83c2c0]
  - @psraghuveer/memento-core@0.6.0
  - @psraghuveer/memento-schema@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [d1b6aaf]
  - @psraghuveer/memento-schema@0.4.0
  - @psraghuveer/memento-core@0.5.0

## 0.2.0

### Minor Changes

- 544e96b: Add memory.context and memory.extract commands (ADR-0016)

  - `memory.extract`: batch extraction with embedding-based dedup (skip/supersede/write) and configurable confidence defaults
  - `memory.context`: query-less ranked retrieval for session-start context injection
  - ~13 new config keys for extraction thresholds, context limits, and ranking weights
  - Remove dead code (`commands/memory/errors.ts`)
  - Harden test coverage across bulk commands, retrieval pipeline, CLI lifecycle, and doc renderers

### Patch Changes

- Updated dependencies [544e96b]
  - @psraghuveer/memento-core@0.4.0
  - @psraghuveer/memento-schema@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [1fdbf05]
  - @psraghuveer/memento-core@0.3.0
  - @psraghuveer/memento-schema@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [b64dd5d]
  - @psraghuveer/memento-core@0.2.0

## 0.1.1

### Patch Changes

- 3957548: Improve MCP tool usability for AI agents

  - Add `.describe()` annotations to all Zod input schemas with examples and format hints
  - Inject OpenAPI 3.1 discriminator hints into JSON Schema output for discriminated unions
  - Include Zod issue summary in INVALID_INPUT error messages for self-correction
  - Default `owner` to `{"type":"local","id":"self"}`, `summary` to `null`, `pinned` and `storedConfidence` to config-driven values (`write.defaultPinned`, `write.defaultConfidence`)
  - Add usage examples to command descriptions
  - Enhance tool discoverability: scope hints, confirm gate guidance, workflow notes

- Updated dependencies [3957548]
  - @psraghuveer/memento-schema@0.1.1
  - @psraghuveer/memento-core@0.1.1
