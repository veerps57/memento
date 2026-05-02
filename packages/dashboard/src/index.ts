// `@psraghuveer/memento-dashboard` package entry.
//
// The published surface is the server module — `createDashboardServer`
// plus a small set of helpers the lifecycle command in
// `@psraghuveer/memento` wires together. The UI code under
// `src/ui/` is built separately by Vite into `dist-ui/` and is
// loaded by the browser, never by Node, so it is never
// re-exported here.
//
// This file exists so that the package's `main` resolves to a
// stable `dist/index.js` and the dashboard server can be
// imported as `@psraghuveer/memento-dashboard` rather than the
// deeper `@psraghuveer/memento-dashboard/server`.

export {
  createDashboardServer,
  resolveDashboardUiDir,
  type CreateDashboardServerOptions,
} from './server/index.js';
