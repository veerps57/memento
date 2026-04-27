# @psraghuveer/memento

The user-facing CLI package. The package is `@psraghuveer/memento`; the binary it installs is `memento`. Run it with `npx @psraghuveer/memento <cmd>` for one-shot use, or `npm install -g @psraghuveer/memento` for a persistent `memento` on your `$PATH`.

This package contains:

- `dist/cli.js` — the published CLI executable (the `bin` entry).
- The thin programmatic API (`src/index.ts`) used by tests and adapter consumers.

The CLI is a structural mirror of [`@psraghuveer/memento-server`](../server) — both are adapters over the [`@psraghuveer/memento-core`](../core) command registry. See ADR [0003](../../docs/adr/0003-single-command-registry.md). Lifecycle commands (`context`, `serve`, `doctor`, `store migrate`) sit alongside a generic projection of the registry surface (`memento <namespace> <verb>`); the full surface is documented in [docs/reference/cli.md](../../docs/reference/cli.md).
