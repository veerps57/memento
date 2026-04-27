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
- Network input is not part of v1 — Memento does not listen on a network socket by default. The stdio transport is used for MCP, which is process-local.

### Defenses Memento Provides

- **Secret scrubbing.** A built-in regex-based scrubber strips known secret patterns (AWS keys, GitHub tokens, JWTs, private keys, generic bearer tokens) before persistence. Patterns are user-configurable, and an allowlist supports false-positive overrides. The scrubber is a defense-in-depth measure; it is **not** a guarantee that no secret will ever be persisted.
- **No outbound network calls by default.** Memento performs zero network requests unless the user explicitly enables a feature that requires one (e.g. cloud embeddings in v2).
- **Schema-validated input.** All MCP tool inputs and CLI arguments are validated through Zod schemas at the boundary. Invalid input is rejected with a typed error code.
- **Append-only audit log.** Every state-changing operation produces an event. Compromise or accidental corruption is at least observable.
- **Soft delete and supersession.** Forgotten and superseded memories are retained for audit and can be restored. Hard deletion requires an explicit administrative command.

### Defenses Memento Does Not Provide

- **Encryption at rest.** The SQLite database is not encrypted in v1. Users requiring encryption should use full-disk encryption or place the store on an encrypted volume. Native encryption is being considered for v2.
- **Per-client authorization.** Any MCP client connected to a running Memento instance has the full tool surface available to it.
- **Tamper detection.** The audit log is append-only by convention but not cryptographically chained.
- **Sandboxing of memory content.** Memory content is treated as opaque text; clients are responsible for safe rendering and execution boundaries.

These limitations are documented in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and tracked toward the v2 roadmap.

## Disclosure Policy

We follow coordinated disclosure. After accepting a report, we will work with the reporter to determine an appropriate fix and disclosure timeline, typically targeting 90 days from acknowledgement to public disclosure. Critical issues may be disclosed sooner alongside a release.

Reporters will be credited in the security advisory unless they request otherwise.
