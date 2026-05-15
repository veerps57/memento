---
'@psraghuveer/memento-core': minor
'@psraghuveer/memento-schema': minor
'@psraghuveer/memento': patch
---

Three new bundled packs, plus a graceful-shutdown fix for the SIGINT-during-startup-backfill crash.

**Three new packs** — `pragmatic-programmer`, `twelve-factor-app`, `google-sre`. High-leverage engineering frameworks shipped as installable packs, each citing the canonical source and translating the original principles into durable preferences/decisions an AI assistant can act on. Pattern matches `engineering-simplicity`: cite the framework, write original engineering applications, CC0-1.0.

- **`pragmatic-programmer` v0.1.0** — 13 memories adapting Dave Thomas and Andy Hunt's "The Pragmatic Programmer" (Addison-Wesley, 1999; 20th Anniversary Edition, 2019). Covers DRY, orthogonality, reversibility, tracer bullets, broken windows, programming by coincidence, design by contract, three-strikes refactoring, design-for-testability.
- **`twelve-factor-app` v0.1.0** — 13 memories adapting Adam Wiggins and the Heroku team's Twelve-Factor App methodology (https://12factor.net, 2011). One memory per factor: codebase, dependencies, config, backing services, build/release/run, processes, port binding, concurrency, disposability, dev/prod parity, logs, admin processes — plus a framework-attribution fact.
- **`google-sre` v0.1.0** — 11 memories adapting the Google SRE corpus ("Site Reliability Engineering" 2016 and "The Site Reliability Workbook" 2018, https://sre.google/books/). Covers embrace-risk, SLOs-before-SLAs, error budgets, toil reduction, blameless postmortems, the four golden signals, simplicity as a reliability property, alert-on-symptoms, hope-is-not-a-strategy, automated reversible releases.

Install with `memento pack install <id>`; uninstall with `memento pack uninstall <id> --confirm`.

**Graceful shutdown** — `MementoApp.shutdown()` is a new async method on the `MementoApp` handle that awaits the in-flight startup embedding backfill (ADR-0021) up to a configurable grace window, then runs the synchronous `close()`. Every lifecycle command (`dashboard`, `serve`, `status`, `doctor`, `init`, `backup`, `import`, `pack`, `context`, registry adapter) now calls `await app.shutdown()` in its `finally` block instead of `app.close()`.

Without it, Ctrl-C during the backfill window tears down the embedder's ONNX worker threads mid-inference and aborts the process with `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument`. The race is most reachable on `memento dashboard` and `memento serve` (long-lived signal-driven processes that wait on SIGINT) but theoretically present on every command. Graceful drain closes the window.

The synchronous `close()` is kept on the interface for embedded callers and tests that coordinate teardown another way. Hosts that run signal-driven lifecycle commands should prefer `shutdown()`.

New config key `embedding.startupBackfill.shutdownGraceMs` (number, default 3000, mutable, range 0–60_000) sets the grace window. Set to 0 to skip the wait entirely (back to fire-and-forget, only safe when the host coordinates teardown another way).

**Bump-type framework** — `.changeset/README.md` now has a "Choosing the bump type" section with two conventions (library packages follow standard semver on public exports; the CLI bumps `minor` only for coherent feature launches and `patch` for everything else additive). Pointers in `CONTRIBUTING.md` and `skills/memento-dev/SKILL.md` so contributors and AI agents both apply it consistently.
