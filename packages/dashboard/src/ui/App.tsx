// Root component: TanStack Query provider, TanStack Router, layout.
//
// We use code-based routing rather than the file-based variant
// because the v0 route set is small (landing, memory, memory/:id,
// conflicts, config, audit, system) and the codegen-free route file
// keeps the build chain simpler — no Vite plugin, no generated
// route tree to commit.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { CommandPalette } from './components/CommandPalette.js';
import { Layout } from './components/Layout.js';
import { createQueryClient } from './lib/query.js';
import { AuditPage } from './routes/audit.js';
import { ConfigPage } from './routes/config.js';
import { ConflictsPage } from './routes/conflicts.js';
import { LandingPage } from './routes/landing.js';
import { MemoryDetailPage } from './routes/memory-detail.js';
import { MemoryListPage } from './routes/memory.js';
import { SystemPage } from './routes/system.js';

const queryClient = createQueryClient();

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Layout>
        <Outlet />
      </Layout>
      <CommandPalette />
    </>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingPage,
});

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory',
  component: MemoryListPage,
});

const memoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory/$id',
  component: MemoryDetailPage,
});

const conflictsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/conflicts',
  component: ConflictsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditPage,
});

const configRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/config',
  component: ConfigPage,
});

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/system',
  component: SystemPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  memoryRoute,
  memoryDetailRoute,
  conflictsRoute,
  auditRoute,
  configRoute,
  systemRoute,
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
