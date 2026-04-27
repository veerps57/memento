// Structural totality test for `retrieval.ranker.strategy`.
//
// The pipeline declares its own `RankerStrategy` literal union
// and dispatches over it with `assertNever`. That gives a
// compile-time guarantee inside the pipeline, but does not, by
// itself, link the union to the registered config schema. This
// test is the linkage: if the registered enum widens (e.g. a
// `reciprocal-rank-fusion` strategy is added in
// `@psraghuveer/memento-schema/config-keys`), this assertion fails — the
// developer is forced to widen `RankerStrategy` and add a case,
// at which point `assertNever` lights up and the missing branch
// surfaces as a typecheck error. Same pattern as the
// `MemoryKind` totality tests (AGENTS.md rule 7).

import { CONFIG_KEYS } from '@psraghuveer/memento-schema';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

describe('retrieval.ranker.strategy registry/pipeline parity', () => {
  it('exposes exactly the strategies the pipeline implements', () => {
    // Pipeline implements: 'linear'. Update this list and add a
    // case in `pipeline.ts#rankByStrategy` together.
    const implemented = ['linear'] as const;
    const schema = CONFIG_KEYS['retrieval.ranker.strategy'].schema as z.ZodEnum<
      ['linear', ...string[]]
    >;
    expect([...schema.options].sort()).toEqual([...implemented].sort());
  });
});
