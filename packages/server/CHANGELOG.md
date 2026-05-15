# @psraghuveer/memento-server

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
