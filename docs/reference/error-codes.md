# Error Codes

> **This file is auto-generated from `@psraghuveer/memento-schema/result` via `pnpm docs:generate`. Do not edit by hand.**

Every fallible Memento operation returns a `Result<T>`; on the failure branch, `error.code` is one of the values listed below.

Codes are stable contract — switch on them, map them to localised messages, build retry policies on top.

Adding a code is non-breaking. Repurposing or removing one is breaking and goes through a deprecation cycle.

Total: 9 codes.

| Code | Description |
| --- | --- |
| `INVALID_INPUT` | The input was rejected by a schema or domain invariant. The caller should fix the request and retry. |
| `NOT_FOUND` | The addressed memory, event, scope, or config key does not exist. The caller should re-resolve the identifier. |
| `CONFLICT` | An optimistic-concurrency or supersedence race was detected. The caller should re-read state and try again. |
| `IMMUTABLE` | The targeted field or config key is fixed for the lifetime of the server (for example `embedder.local.model`). Restart with new configuration to change it. |
| `CONFIG_ERROR` | A config write failed its per-key schema. The previous value remains in effect; correct the value and retry. |
| `SCRUBBED` | A write was rejected because scrubbing removed all meaningful content. The caller should provide content that is not entirely sensitive. |
| `STORAGE_ERROR` | SQLite or filesystem failure. The operation may be retried after the underlying issue is resolved (disk full, lock contention, permissions). |
| `EMBEDDER_ERROR` | The local embedder model failed (load, inference, or shape mismatch). Vector-dependent operations are unavailable until it recovers. |
| `INTERNAL` | An unexpected runtime failure (a bug). The error message is the only available signal; capture it and file an issue. |
