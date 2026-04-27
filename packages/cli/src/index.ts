// @psraghuveer/memento — the user-facing entry point.
//
// This module exposes the programmatic surface (rare; mostly used
// by tests and embeddings). The actual executable lives in
// cli.ts and is what `npx memento` launches.

export {
  buildCliAdapter,
  type BuildCliAdapterOptions,
  type CliAdapter,
} from './build-adapter.js';
export {
  parseArgv,
  type CliEnv,
  type LifecycleName,
  type ParseArgvOptions,
  type ParsedCommand,
} from './argv.js';
export {
  ERROR_CODE_TO_EXIT,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeFor,
} from './exit-codes.js';
export { renderBanner, shouldUseColor, type BannerOptions } from './banner.js';
export { renderHelp } from './help.js';
export { type CliIO, type CliWritable, nodeIO } from './io.js';
export {
  contextCommand,
  LIFECYCLE_COMMANDS,
  type ContextCommandEntry,
  type ContextSnapshot,
  type LifecycleCommand,
  type LifecycleDeps,
  type LifecycleInput,
} from './lifecycle/index.js';
export { runContext } from './lifecycle/context.js';
export {
  type CliFormat,
  type CliFormatOption,
  type RenderedResult,
  renderResult,
  resolveFormat,
} from './render.js';
export { runCli, type RunCliDeps } from './run.js';
export { resolveVersion } from './version.js';
