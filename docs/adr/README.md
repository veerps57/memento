# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for Memento. Each ADR captures one decision: the context, the decision itself, the consequences, and the alternatives considered.

ADRs are immutable. To overturn a decision, write a new ADR that supersedes the old one — never edit a historical ADR. The `Status` field of the old ADR is updated to `Superseded by ADR-XXXX` as part of the new ADR's PR.

The template is at [`template.md`](template.md). Use it.

## Index

| #    | Title                                                                  | Status   |
| ---- | ---------------------------------------------------------------------- | -------- |
| 0001 | [SQLite as the storage engine](0001-sqlite-as-storage-engine.md)       | Accepted |
| 0002 | [Single typed config schema as source of truth](0002-zod-config-schema.md) | Accepted |
| 0003 | [Single command registry, MCP and CLI as adapters](0003-single-command-registry.md) | Accepted |
| 0004 | [Lazy, query-time decay (no scheduled jobs)](0004-lazy-query-time-decay.md) | Accepted |
| 0005 | [Conflict detection as a post-write hook](0005-conflict-detection-post-write-hook.md) | Accepted |
| 0006 | [Local embeddings only](0006-local-embeddings-only-in-v1.md)           | Accepted |
| 0007 | [OwnerRef is not Scope](0007-ownerref-is-not-scope.md)                 | Accepted |
| 0008 | [No relatedTo / generic graph edges](0008-no-relatedto-in-v1.md)       | Accepted |
| 0009 | [Apache-2.0 license](0009-apache-2.0-license.md)                       | Accepted |
| 0010 | [MCP tool names use `verb_noun` snake_case](0010-mcp-tool-naming.md)   | Accepted |
| 0011 | [Assistant-callable system commands](0011-assistant-callable-system-commands.md) | Accepted |
| 0012 | [Safety gates: confirm, idempotency, redaction, batch limits](0012-safety-gates.md) | Accepted |
| 0013 | [Portable export/import — JSONL artefact for migration and exit](0013-portable-export-import.md) | Accepted |
| 0014 | [Bulk-destructive operations — `forget_many` / `archive_many` with cap and dry-run](0014-bulk-destructive-operations.md) | Accepted |
| 0015 | [Deprecation policy for registry commands](0015-deprecation-policy.md) | Accepted |
| 0016 | [Assisted Extraction and Context Injection](0016-assisted-extraction-and-context-injection.md) | Accepted |
| 0017 | [Async Extraction, Batched Embeddings, and Bulk Repository Operations](0017-async-extraction-batched-embeddings-bulk-ops.md) | Accepted |
| 0018 | [Memento Dashboard as a sibling package](0018-dashboard-package.md) | Accepted |
| 0019 | [Import re-stamp policy](0019-import-re-stamp-policy.md) | Accepted |
| 0020 | [Memento packs — curated YAML bundles for cold-start seeding](0020-memento-packs.md) | Accepted |
| 0021 | [Install-time embedding (sync) and startup backfill (async)](0021-install-time-embedding-and-startup-backfill.md) | Accepted |
| 0022 | [Publishing to the official MCP Registry](0022-mcp-registry-publishing.md) | Proposed |

## When an ADR is required

A change needs an ADR if it:

- Changes the public MCP or CLI surface.
- Changes the data model or scope semantics.
- Adds or removes a top-level dependency.
- Changes a load-bearing default in the config.
- Reverses a previous decision.

Routine refactors, doc fixes, and bug fixes do not need ADRs.
