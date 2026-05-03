// Default scrubber rule set.
//
// The canonical rule set lives in `@psraghuveer/memento-schema`
// (where `config-keys.ts` references it as the default value of
// `scrubber.rules`). This module re-exports it so consumers of
// `@psraghuveer/memento-core` can import the rules without
// pulling the schema package in directly. Maintaining one
// source of truth eliminates the drift hazard that comes with
// two parallel copies — every rule change happens in
// `packages/schema/src/scrubber.ts`.

export { DEFAULT_SCRUBBER_RULES } from '@psraghuveer/memento-schema';
