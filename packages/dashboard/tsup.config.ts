import { createConfig } from '../../tsup.config.base';

// The dashboard's published surface is the server module
// re-exported from `src/index.ts` (which forwards to
// `src/server/index.ts`). The Vite-built UI assets ship
// alongside in `dist-ui/` and are served as static files; they
// are not imported by the server bundle.
//
// We deliberately do NOT include the UI source in this entry —
// downstream consumers never embed React; they spawn the
// dashboard server, which then serves the prebuilt UI.
export default createConfig({
  entry: ['src/index.ts'],
});
