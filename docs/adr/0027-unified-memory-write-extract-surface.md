# ADR-0027: Unified `memory.write` / `memory.extract` surface

- **Status:** Accepted
- **Date:** 2026-05-17
- **Deciders:** Raghu + Claude
- **Tags:** schema, write-surface, extract, dx, breaking-change

## Context

`memory.write` and `memory.extract` are the two paths assistants use to put data in the store. They were designed at different times (extract landed with [ADR-0016](0016-assisted-extraction-and-context-injection.md), write predates it) and ended up with three avoidable differences in their input shape:

1. **`kind` shape.** `memory.write` takes a discriminated-union object: `kind: { type: "fact" }`, `kind: { type: "decision", rationale: "..." }`, `kind: { type: "snippet", language: "typescript" }`. `memory.extract` takes a flat string plus top-level fields: `kind: "fact"`, plus `rationale: "..."` and `language: "typescript"` beside it. Both encode the same five-variant model.

2. **Processing default.** `memory.extract` defaults to `extraction.processing: 'async'` — the response returns immediately with empty `written` / `skipped` / `superseded` arrays and a `hint` field. Assistants new to Memento read the empty arrays as a failure and retry. The skill calls this out, the tool description calls this out, the persona snippet calls this out — the prose has been compensating for an unfriendly shape.

3. **`topic: value` enforcement was opt-in.** `safety.requireTopicLine` already exists and defaults to `true`, so this part is in place — but the rule was added late and is still inconsistently documented across the persona snippet and onboarding docs.

The cumulative cost of (1) is real: the skill explicitly warns about the shape mismatch in three places, and observed sessions still trip on it. The cost of (2) is real: the empty-array receipt is the single most confusing response in the surface.

We are pre-1.0; the package is at 0.7.3. We can break the public input shape here at the cost of a minor-version bump and a coordinated docs / pack / skill / persona update. After 1.0 the cost goes up sharply.

## Decision

Land three shape changes together as one coherent surface revamp, gated behind one ADR and one changeset:

### 1. Nested `kind` everywhere

`memory.extract`'s `ExtractionCandidateSchema` adopts the same `kind: MemoryKindSchema` shape that `memory.write` uses. The flat `kind: enum` and the top-level `rationale` / `language` fields are removed.

Caller diff:

```diff
- {"kind": "decision", "rationale": "FTS5 + single file", "content": "..."}
+ {"kind": {"type": "decision", "rationale": "FTS5 + single file"}, "content": "..."}

- {"kind": "snippet", "language": "shell", "content": "memento init"}
+ {"kind": {"type": "snippet", "language": "shell"}, "content": "memento init"}

- {"kind": "fact", "content": "..."}
+ {"kind": {"type": "fact"}, "content": "..."}
```

This is a breaking schema change to a public MCP / CLI command. Per the version policy, it bumps `@psraghuveer/memento` and `@psraghuveer/memento-core` by a minor version (pre-1.0). The changeset spells out the migration path for any caller that hand-constructs extract payloads.

### 2. Hybrid sync/async extraction

`extraction.processing` gains a third value: `'auto'` (new default).

- `'auto'` — sync if `candidates.length <= extraction.syncThreshold`; otherwise async. New config key `extraction.syncThreshold` (default `10`).
- `'sync'` — always synchronous. Existing semantics, unchanged.
- `'async'` — always asynchronous. Existing semantics, unchanged.

For the typical AI-driven session-end sweep (a handful of candidates), the response is now sync — `written`, `skipped`, `superseded` are populated, and the assistant can report results to the user directly. Large batches (migrations, packs) stay async so the caller is not blocked on embedding work.

The response shape is unchanged — `mode: 'sync' | 'async'` already discriminates, and the `hint` field still nudges async callers about when results land. Operators with deployments that depend on always-async behavior set `extraction.processing: 'async'` explicitly.

### 3. Topic-line enforcement is the documented default

`safety.requireTopicLine` already defaults to `true` (no code change) but the documentation surfaces (persona snippet, README, skill) still hedge as if the rule were opt-in. This ADR ratifies the default and updates every document to state the rule as binding, with a one-line note that an operator can flip `safety.requireTopicLine: false` to keep the historical permissive shape.

## Consequences

### Positive

- One shape to learn for both write paths. The skill drops its three-place warning about the shape mismatch.
- The "empty-arrays receipt looks like a failure" UX disappears for typical AI sessions (≤10 candidates).
- Topic-line enforcement is stated as the contract, not hedged as an opt-in — assistants stop writing preferences without the first-line anchor "to be safe".
- Future write-shape additions (a new memory kind, a new optional field) require touching one schema, not two.

### Negative

- Breaking change to `memory.extract`'s public input shape. Callers that hand-construct extract payloads (memento packs in `packages/cli/packs/*.yaml`, persona snippets, the skill, downstream agents) must migrate to the nested form. Mitigation: every in-repo caller is updated in the same branch as this ADR, and the changeset entry calls the breakage out at the top.
- Async-default callers see behaviour change if `extraction.processing` was left at the default and they had been relying on the unconditional async receipt. Mitigation: the `mode` field on the response is unchanged; a defensive caller already branches on `mode === 'async'`. Operators who need always-async can set the config explicitly.

### Risks

- The migration window for out-of-repo callers (custom agents, packs published outside this repo) is real. Mitigation: pre-1.0 breaking-change policy explicitly allows this with a `minor` bump and a changeset; the changeset will name the old and new shape side-by-side so the migration is one-line per call site. Holding on the old shape past 1.0 would have been worse.
- A caller submits a small batch via `'auto'` expecting async, sees a sync response, and is surprised. Mitigation: the `mode` field continues to discriminate explicitly; nothing on the wire becomes ambiguous. The hint copy is updated to mention the threshold.

## Alternatives considered

### Alternative A: keep flat-kind on extract, accept the prose tax

- Don't change the schemas; keep the skill / persona / tool descriptions warning about the shape mismatch.
- Attractive: no breaking change; no caller migration.
- Rejected: the prose tax is real (three skill warnings, observed sessions still trip), and the cost grows over time as more agents are written against the surface. The pre-1.0 window is the cheapest moment to unify.

### Alternative B: flat-kind everywhere (extract's shape wins)

- Migrate `memory.write` and `memory.supersede.next` to take `kind: enum` plus top-level `rationale` / `language`.
- Attractive: flat shapes are sometimes easier for LLMs to construct correctly.
- Rejected: the nested discriminated-union is the canonical TS shape and the one that `MemoryKindSchema` already enforces structurally. Flattening would either duplicate the enum constraint at multiple sites or weaken the structural validation that the existing write path depends on for kind-specific fields. The reuse argument runs the other way.

### Alternative C: always-sync extract (drop async entirely)

- Replace `extraction.processing` with no config; every call is sync.
- Attractive: simplest mental model.
- Rejected: large batches (pack installs, migrations) genuinely benefit from a fire-and-forget receipt — the caller does not want to block on N×embedding work. The `'auto'` mode preserves both modes behind one default.

### Alternative D: bundle the kind change with a 1.0 release

- Wait, do the unification when we bump major.
- Attractive: aligns the breaking change with a marketing moment.
- Rejected: the launch window calls for a clean 0→1 install journey *now*, not after a 1.0 cut. The pre-1.0 minor-bump policy exists precisely for this — using it is cheaper than carrying the divergent shapes into 1.0 stability promises.

## Validation against the four principles

1. **First principles.** Two ways to spell the same five-variant model is one too many. The reason the divergence exists (extract landed later, flat kind was thought to be friendlier for LLMs) was tested by adoption; the result was a prose tax in three places. Removing the divergence is what first-principles thinking points at.
2. **Modular.** The unified shape reuses `MemoryKindSchema` from `@psraghuveer/memento-schema` on both sides. The handler-level wiring (`enforceTopicLine`, `enforceSafetyCaps`, `rationaleFromKind`) stays in `safety-caps.ts` and works against the unified shape with no special casing.
3. **Extensible.** A new memory kind (or a new optional kind-specific field) is added by extending `MemoryKindSchema` once. Both write and extract pick it up automatically. The flat-kind divergence forced two edits per addition; the unified shape removes that.
4. **Config-driven.** `extraction.syncThreshold`, `extraction.processing`, `safety.requireTopicLine` are all `ConfigKey`s. Operators can replicate the legacy async-everywhere or permissive-topic behavior without a code change.

## References

- ADR-0016: Assisted extraction and context injection (introduced `memory.extract` with the flat kind shape this ADR unifies).
- ADR-0026: MCP `instructions` as the session-teaching spine (the spine teaches the nested shape as canonical, which only works once this ADR lands).
- ADR-0017: Async extraction processing (the hybrid mode preserves the always-async option via explicit config).
- [`packages/core/src/commands/memory/extract.ts`](../../packages/core/src/commands/memory/extract.ts) — `ExtractionCandidateSchema` (pre-change shape).
- [`packages/core/src/commands/memory/safety-caps.ts`](../../packages/core/src/commands/memory/safety-caps.ts) — `enforceTopicLine` (binding under `safety.requireTopicLine`).
