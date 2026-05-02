---
'@psraghuveer/memento-dashboard': patch
---

Republish `@psraghuveer/memento-dashboard` to fix unresolved `workspace:^` specifiers in the published `package.json`.

The initial `0.1.0` tarball was pushed manually, bypassing the changesets/CI publish path that rewrites pnpm's `workspace:` protocol to concrete semver ranges. As a result, `npm install -g @psraghuveer/memento` fails during dependency resolution because npm cannot resolve `workspace:^` for `@psraghuveer/memento-core` and `@psraghuveer/memento-schema`.

This release is a no-op republish through the standard `changeset publish` flow, which produces a tarball with the workspace specifiers correctly rewritten to `^0.5.0` and `^0.4.0`.
