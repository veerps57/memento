# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Memento, **please do not open a public issue**. Instead, report it privately:

- Use [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) on the Memento repository to open a private report.
- Or, if you cannot use GitHub Security Advisories, contact the maintainers via the email address listed in the repository's `FUNDING.yml` or maintainer profile.

We will acknowledge receipt within five business days, and aim to provide a substantive response (including a remediation timeline if applicable) within fourteen business days.

## Supported Versions

Memento is pre-1.0. During this period, only the latest released version is supported with security fixes.

After 1.0, we will publish a support matrix here listing which minor versions receive security backports.

## Threat Model

Memento is designed with the following assumptions and constraints. Understanding these helps both reporters and contributors think clearly about what is and is not a security concern.

### Trusted

- The local user account running Memento is trusted with full access to the data.
- The local filesystem and operating system isolation are trusted.
- The MCP clients connected to Memento (Claude Code, Cursor, OpenCode, etc.) are trusted to receive whatever data Memento returns to them. Memento does not enforce per-tool authorization in v1.

### Untrusted

- Content written into memory may originate from prompts, model output, or extracted text and should be treated as potentially adversarial. Memento does not execute memory content; it stores and returns it as data.
- Stdio MCP transport is process-local. The dashboard is the one optional network-bound surface — it binds to `127.0.0.1` only, and every API call is gated by a per-launch random token (see "Defenses" below).
- Import artefacts (`memento export` JSONL files) handed in via `memento import` are treated as adversarial: the importer never trusts caller-supplied audit claims. See [ADR-0019](docs/adr/0019-import-re-stamp-policy.md).

### Defenses Memento Provides

- **Secret scrubbing.** A built-in regex-based scrubber strips known secret patterns (OpenAI keys, Slack tokens, GitHub tokens, AWS access keys, JWTs, PEM private-key blocks, HTTP `Authorization: Bearer` headers, secret-bearing variable assignments, email addresses) before persistence. Every write runs the scrubber over `content`, `summary`, and (for `decision`-kind memories) `kind.rationale`. The default rule set is operator-pinned — `scrubber.enabled` and `scrubber.rules` are immutable at runtime so a prompt-injected MCP `config.set` cannot disable redaction before a write. The scrubber engine enforces a per-rule wallclock budget (`scrubber.engineBudgetMs`) so a runaway regex cannot block the writer thread. Best-effort by design — see [`docs/architecture/scrubber.md`](docs/architecture/scrubber.md).
- **Import re-stamp policy ([ADR-0019](docs/adr/0019-import-re-stamp-policy.md)).** Every imported memory has its `OwnerRef` rewritten to local-self, has its content / summary / rationale re-scrubbed with the importer's current rules, and (under default settings) has its source audit-event chain collapsed into one synthetic `memory.imported` event. The audit log on the target machine cannot be back-dated or attributed to a foreign actor by a hand-crafted artefact. Per-record JSON payloads are capped to bound storage-bloat attacks.
- **Resource caps.** Schema-level ceilings on `memory.write` content (1 MiB), summary (64 KiB), and tag count (1024) at the wire boundary; operator-tunable `safety.*` caps below those (defaults: 64 KiB content, 2 KiB summary, 64 tags). The MCP stdio transport rejects messages above `server.maxMessageBytes` (4 MiB default). The local embedder truncates input to `embedder.local.maxInputBytes` (32 KiB default) and aborts with a typed error after `embedder.local.timeoutMs` (10 s default). `memento import` rejects artefacts larger than `import.maxBytes` (256 MiB default) before parsing begins.
- **Schema-validated input.** All MCP tool inputs and CLI arguments are validated through Zod schemas at the boundary. Invalid input is rejected with a typed error code.
- **Append-only audit log.** Every state-changing operation produces an event. Compromise or accidental corruption is at least observable.
- **Soft delete and supersession.** Forgotten and superseded memories are retained for audit and can be restored. Hard deletion requires an explicit administrative command.
- **Dashboard authentication.** When the optional `memento dashboard` HTTP server is running, every `/api/*` request must carry a per-launch random token (`Authorization: Bearer <token>`). Mutating requests must additionally pass an exact-origin check against the dashboard's bound port; every request must pass a `Host` allowlist (defence-in-depth against DNS rebinding). The HTTP API filters to a small dashboard-surface allowlist of registry commands; new commands default to mcp+cli-only and must explicitly opt in.
- **File system hygiene.** SQLite databases, backups, exports, and the serve log are written with mode `0600`. The data directory and embedder model cache are created with mode `0700`. SQLite opens with `pragma trusted_schema = OFF` so a malicious hand-crafted `.db` cannot wire triggers that mutate rows on first read.
- **Supply-chain hygiene.** Postinstall scripts pass a closed env allowlist (drops `npm_config_script_shell`, `NODE_OPTIONS`, `PREBUILD_INSTALL_HOST`, etc.) when invoking `npm`/`npx`, and resolve `npm` via `process.env.npm_execpath` rather than `PATH` to avoid `node_modules/.bin` hijack.
- **Error-message redaction.** `INTERNAL` and `STORAGE_ERROR` messages returned to MCP clients have absolute filesystem paths replaced with `<path>`, so SQLite errors do not leak host filesystem layout.
- **No outbound network calls by default.** Memento performs zero network requests for normal operation. The local embedder downloads its ONNX model from the Hugging Face Hub on first use; this is the only outbound traffic and only fires when `retrieval.vector.enabled` is `true` (the default; can be disabled via `memento config set retrieval.vector.enabled false`).

### Defenses Memento Does Not Provide

- **Encryption at rest.** The SQLite database is not encrypted in v1. Users requiring encryption should use full-disk encryption or place the store on an encrypted volume. Native encryption is being considered for v2.
- **Per-MCP-client authorization.** Any MCP client connected to a running Memento instance has the full mcp-surface tool set available to it. The dashboard surface is gated by the per-launch token (above); the MCP surface is not.
- **Tamper detection.** The audit log is append-only by convention but not cryptographically chained.
- **Sandboxing of memory content.** Memory content is treated as opaque text; clients are responsible for safe rendering and execution boundaries.
- **Cryptographic signatures on import artefacts.** `memento import` verifies an artefact's SHA-256 footer for integrity but does not authenticate the source. The re-stamp policy ([ADR-0019](docs/adr/0019-import-re-stamp-policy.md)) is the load-bearing defence against forged audit history; signed artefacts are not on the v1 roadmap.

These limitations are documented in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and tracked toward the v2 roadmap.

## Disclosure Policy

We follow coordinated disclosure. After accepting a report, we will work with the reporter to determine an appropriate fix and disclosure timeline, typically targeting 90 days from acknowledgement to public disclosure. Critical issues may be disclosed sooner alongside a release.

Reporters will be credited in the security advisory unless they request otherwise.
