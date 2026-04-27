export {
  CONFLICT_POLICIES,
  DEFAULT_POLICY_CONFIG,
  runPolicy,
} from './policies.js';
export type {
  ConflictPolicy,
  ConflictPolicyConfig,
  PolicyResult,
} from './policies.js';
export { createConflictRepository } from './repository.js';
export type {
  ConflictListFilter,
  ConflictOpenInput,
  ConflictRepository,
  ConflictRepositoryDeps,
} from './repository.js';
export { detectConflicts } from './detector.js';
export type {
  DetectConflictsOptions,
  DetectConflictsResult,
} from './detector.js';
export { runConflictHook } from './hook.js';
export type {
  ConflictHookConfig,
  ConflictHookDeps,
  ConflictHookOptions,
  ConflictHookOutcome,
} from './hook.js';
