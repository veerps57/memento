# ADR-0009: Apache-2.0 license

- **Status:** Accepted
- **Date:** 2026-04-25
- **Deciders:** Memento Authors
- **Tags:** licensing

## Context

Open-source license options:

- **MIT / BSD-2-Clause** — minimal, permissive.
- **Apache-2.0** — permissive plus an explicit patent grant and a NOTICE file convention.
- **MPL-2.0** — file-level copyleft; complicates downstream use.
- **GPL-3.0** — strong copyleft; rejected for adoption reasons.

Memento is a developer tool intended for use inside enterprises. Patent indemnification matters. The Apache-2.0 patent grant is meaningful in that context.

## Decision

License under Apache-2.0. Ship a `LICENSE` and a `NOTICE` file. Contributions are accepted under the same terms (per the contributor license declaration in the Apache-2.0 text and `CONTRIBUTING.md`).

## Consequences

### Positive

- Explicit patent grant lowers enterprise legal review friction.
- Compatible with most downstream licenses.
- NOTICE convention gives a clean place to document attributions.

### Negative

- Slightly more verbose than MIT.
- Apache-2.0 + GPLv2 (without the v3 upgrade clause) is incompatible. Acceptable trade-off.

### Risks

- None material.

## Alternatives considered

### MIT

Attractive: simplest. Rejected: no patent grant; weaker enterprise signal.

### MPL-2.0

Attractive: file-level copyleft is a middle ground. Rejected: complicates use of Memento as a library inside closed-source agents.

## Validation against the four principles

1. **First principles.** Choose the license that matches the audience (developers in enterprises) rather than the default (MIT).
2. **Modular.** N/A.
3. **Extensible.** N/A.
4. **Config-driven.** N/A.

## References

- [LICENSE](../../LICENSE)
- [NOTICE](../../NOTICE)
