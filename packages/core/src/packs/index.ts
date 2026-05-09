// `@psraghuveer/memento-core/packs` — engine-side primitives for
// memento packs (ADR-0020). Pure functions and stateless
// resolvers; the registry commands and CLI lifecycle wrappers
// live in `commands/packs/` and the cli package respectively.

export {
  type PackParseFailure,
  type PackParseOutcome,
  type PackParseSuccess,
  parsePackManifest,
} from './parse.js';

export {
  type DefaultResolverOptions,
  type PackResolveErrorCode,
  type PackResolveResult,
  type PackSource,
  type PackSourceResolver,
  createDefaultPackSourceResolver,
} from './resolve.js';

export {
  type PackInstallOptions,
  type PackInstallState,
  type PackInstallStateName,
  type PackInstallTranslation,
  checkInstallState,
  derivePackClientToken,
  translateManifestToWriteInputs,
} from './install.js';

export {
  buildAllVersionsUninstallTagPrefix,
  buildSingleVersionUninstallFilter,
  memoryHasAnyVersionOfPack,
  uninstallListFilter,
} from './uninstall.js';
