---
"@psraghuveer/memento": patch
---

Fix embedder resolution failure in global npm installs by removing the `createRequire` gate that silently returned `undefined` when the package was actually present.
