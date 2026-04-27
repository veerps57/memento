// Lifecycle command registry.
//
// One typed map keyed by the `LifecycleName` ADT variant. Adding
// a new lifecycle command means widening `LifecycleName` in
// `argv.ts` AND adding a slot here — TypeScript enforces the
// pair via the `Record<LifecycleName, …>` type, so the dispatch
// table can never drift from the parser's accepted set.

import type { LifecycleName } from '../argv.js';
import { backupCommand } from './backup.js';
import { completionsCommand } from './completions.js';
import { contextCommand } from './context.js';
import { doctorCommand } from './doctor.js';
import { explainCommand } from './explain.js';
import { exportCommand } from './export.js';
import { importCommand } from './import.js';
import { initCommand } from './init.js';
import { pingCommand } from './ping.js';
import { serveCommand } from './serve.js';
import { statusCommand } from './status.js';
import { storeMigrateCommand } from './store-migrate.js';
import type { LifecycleCommand } from './types.js';
import { uninstallCommand } from './uninstall.js';

export const LIFECYCLE_COMMANDS: Record<LifecycleName, LifecycleCommand> = {
  serve: serveCommand,
  context: contextCommand,
  doctor: doctorCommand,
  'store.migrate': storeMigrateCommand,
  export: exportCommand,
  import: importCommand,
  init: initCommand,
  status: statusCommand,
  ping: pingCommand,
  uninstall: uninstallCommand,
  backup: backupCommand,
  completions: completionsCommand,
  explain: explainCommand,
};

export type {
  LifecycleCommand,
  LifecycleDeps,
  LifecycleInput,
  MigrateStoreOptions,
  ServeStdioOptions,
} from './types.js';
export {
  contextCommand,
  type ContextSnapshot,
  type ContextCommandEntry,
} from './context.js';
export {
  doctorCommand,
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from './doctor.js';
export {
  storeMigrateCommand,
  runStoreMigrate,
  type StoreMigrateEntry,
  type StoreMigrateSnapshot,
} from './store-migrate.js';
export {
  exportCommand,
  runExport,
  type ExportSnapshot,
} from './export.js';
export {
  importCommand,
  runImport,
  type ImportSnapshotResult,
} from './import.js';
export {
  initCommand,
  runInit,
  type InitSnapshot,
} from './init.js';
export {
  statusCommand,
  runStatus,
  type StatusSnapshot,
} from './status.js';
export {
  pingCommand,
  runPing,
  type PingSnapshot,
} from './ping.js';
export {
  uninstallCommand,
  runUninstall,
  type UninstallSnapshot,
  type UninstallEntry,
} from './uninstall.js';
export {
  backupCommand,
  runBackup,
  type BackupSnapshot,
} from './backup.js';
export {
  completionsCommand,
  runCompletions,
  type CompletionsSnapshot,
} from './completions.js';
export {
  explainCommand,
  runExplain,
  type ExplainSnapshot,
} from './explain.js';
export { serveCommand, runServe } from './serve.js';
export { openAppForSurface, type OpenAppOptions } from './open-app.js';
