// @psraghuveer/memento-core — the Memento engine.
//
// This package owns the storage and engine-side primitives:
//   - Storage scaffold (better-sqlite3 + Kysely; pragmas; migrations)
//   - Migrations (memories + events + FTS5; config_events; conflicts)
//   - MemoryRepository + EventRepository (write/read/list/lifecycle)
//   - Effective-read scope resolver (per scope-semantics.md)
//   - Scrubber (pure rule engine + DEFAULT_SCRUBBER_RULES)
//   - Decay engine + `compact` archival pass (ADR 0004)
//   - Conflict detection + supersession workflow (ADR 0005)
//   - Embedding hook + bulk re-embedding driver
//   - The `EmbeddingProvider` interface (impls live elsewhere; ADR 0006)
//   - The single command registry + validating execute path (ADR 0003)
//
// Transport-agnostic: nothing in this package speaks MCP or CLI.
// Adapters live in `@psraghuveer/memento-server` and `@psraghuveer/memento-cli`; both bind
// to the same registry, so command parity is structural.
//
// Standalone-callable subsystems: `detectConflicts` and `reembedAll`
// are not wired into `MemoryRepository.write`. The server / a hook
// in the higher layer composes them with writes (per ADR 0005).
//
// Re-exports below are the package's stable public surface. The
// schema layer (`@psraghuveer/memento-schema`) is the source of truth for
// `Memory`, `MemoryEvent`, `Conflict`, `Embedding`, `Scope`, etc.;
// import them directly from there.

export { migrateToLatest, MIGRATIONS, openDatabase } from './storage/index.js';
export type {
  MementoDatabase,
  MementoSchema,
  Migration,
  MigrationOutcome,
  OpenDatabaseOptions,
} from './storage/index.js';
export {
  createMemoryRepository,
  createEventRepository,
  ulid,
} from './repository/index.js';
export type {
  MemoryRepository,
  MemoryWriteInput,
  MemoryListFilter,
  MemoryUpdatePatch,
  EmbeddingInput,
  EventRepository,
  EventListFilter,
  RepositoryDeps,
} from './repository/index.js';
export {
  effectiveScopes,
  resolveEffectiveScopes,
  scopeKey,
} from './scope/index.js';
export type { ActiveScopes, ScopeFilter } from './scope/index.js';
export { applyRules, DEFAULT_SCRUBBER_RULES } from './scrubber/index.js';
export type { ScrubResult } from './scrubber/index.js';
export {
  compact,
  DEFAULT_DECAY_CONFIG,
  decayFactor,
  effectiveConfidence,
  MS_PER_DAY,
} from './decay/index.js';
export type {
  CompactOptions,
  CompactStats,
  DecayConfig,
  HalfLifeByKind,
} from './decay/index.js';
export {
  CONFLICT_POLICIES,
  createConflictRepository,
  DEFAULT_POLICY_CONFIG,
  detectConflicts,
  runConflictHook,
  runPolicy,
} from './conflict/index.js';
export type {
  ConflictHookConfig,
  ConflictHookDeps,
  ConflictHookOptions,
  ConflictHookOutcome,
  ConflictListFilter,
  ConflictOpenInput,
  ConflictPolicy,
  ConflictPolicyConfig,
  ConflictRepository,
  ConflictRepositoryDeps,
  DetectConflictsOptions,
  DetectConflictsResult,
  PolicyResult,
} from './conflict/index.js';
export { reembedAll } from './embedding/index.js';
export type {
  EmbeddingProvider,
  ReembedOptions,
  ReembedResult,
  ReembedSkip,
} from './embedding/index.js';
export { embedBatchFallback } from './embedding/index.js';
export { createRegistry, defaultMcpName, deriveMcpName, executeCommand } from './commands/index.js';
export type {
  AnyCommand,
  Command,
  CommandContext,
  CommandMetadata,
  CommandRegistry,
  CommandRegistryBuilder,
  CommandSideEffect,
  CommandSurface,
  McpHints,
} from './commands/index.js';
export { createConfigStore } from './config/index.js';
export type { ConfigOverrides, ConfigStore } from './config/index.js';
export {
  rankLinear,
  sanitizeFtsQuery,
  searchFts,
  searchMemories,
} from './retrieval/index.js';
export type {
  FtsHit,
  FtsSearchOptions,
  RankerOptions,
  RankerWeights,
  RawCandidate,
  ScoreBreakdown,
  SearchDeps,
  SearchQuery,
  SearchResult,
} from './retrieval/index.js';
export { createMementoApp } from './bootstrap.js';
export type { CreateMementoAppOptions, MementoApp } from './bootstrap.js';

// Portable export/import (P1.4 + P1.15, ADR-0013). Stream a
// `memento-export/v1` JSONL artefact in/out of a database with a
// SHA-256 integrity check and per-record schema validation.
export {
  EXPORT_FORMAT,
  ExportFooterSchema,
  ExportHeaderSchema,
  ExportRecordSchema,
  EmbeddingRecordSchema,
  MemoryRecordSchema,
  MemoryEventRecordSchema,
  ConflictRecordSchema,
  ConflictEventRecordSchema,
  exportSnapshot,
  importSnapshot,
} from './portability/index.js';
export type {
  EmbeddingRecord,
  ExportFooter,
  ExportHeader,
  ExportOptions,
  ExportRecord,
  ExportSummary,
  ExportWriter,
  ImportConflictPolicy,
  ImportOptions,
  ImportSummary,
} from './portability/index.js';

// Memento packs (ADR-0020). Curated YAML bundles that seed a
// fresh store. The engine layer is pure: parser, resolvers
// (bundled / file / URL), translator, drift check. Commands and
// CLI lifecycle wrappers compose these primitives downstream.
export {
  buildAllVersionsUninstallTagPrefix,
  buildSingleVersionUninstallFilter,
  checkInstallState,
  createDefaultPackSourceResolver,
  derivePackClientToken,
  memoryHasAnyVersionOfPack,
  parsePackManifest,
  translateManifestToWriteInputs,
  uninstallListFilter,
} from './packs/index.js';
export type {
  DefaultResolverOptions,
  PackInstallOptions,
  PackInstallState,
  PackInstallStateName,
  PackInstallTranslation,
  PackParseFailure,
  PackParseOutcome,
  PackParseSuccess,
  PackResolveErrorCode,
  PackResolveResult,
  PackSource,
  PackSourceResolver,
} from './packs/index.js';

// Reference-doc renderers (consumed by the repo's `pnpm
// docs:generate` / `docs:check` scripts; pure functions over
// the registries, no I/O).
export {
  renderCliDoc,
  renderConfigKeysDoc,
  renderErrorCodesDoc,
  renderMcpToolsDoc,
  type LifecycleDocEntry,
} from './docs/index.js';
