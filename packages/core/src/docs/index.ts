// Reference-doc renderers.
//
// Each renderer is a pure function from source-of-truth data
// (the command registry, the config-key registry, the error-code
// enum) to a Markdown string. The runner script in
// `scripts/docs.mjs` composes them and writes / diffs the
// resulting files under `docs/reference/`.

export { renderCliDoc, type LifecycleDocEntry } from './render-cli.js';
export { renderConfigKeysDoc } from './render-config-keys.js';
export { renderErrorCodesDoc } from './render-error-codes.js';
export { renderMcpToolsDoc } from './render-mcp-tools.js';
