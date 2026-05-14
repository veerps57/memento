---
"@psraghuveer/memento": patch
---

Bake the `mcpName: "com.runmemento/memento"` field into the published tarball so the official MCP Registry can verify this package backs the canonical server entry. The field was added in #58 (ADR-0022) but missed the prior npm publish; this patch ships it. No runtime behavior change.
