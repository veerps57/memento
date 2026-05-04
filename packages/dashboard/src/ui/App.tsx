// Root component: TanStack Query provider, TanStack Router, layout.
//
// We use code-based routing rather than the file-based variant
// because the v0 route set is small (landing, memory, memory/:id,
// conflicts, config, audit, system) and the codegen-free route file
// keeps the build chain simpler — no Vite plugin, no generated
// route tree to commit.

import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { CommandPalette } from './components/CommandPalette.js';
import { Layout } from './components/Layout.js';
import { TokenMissingPanel } from './components/TokenMissingPanel.js';
import { AUTH_REQUIRED_CODE } from './lib/api.js';
import { createQueryClient } from './lib/query.js';
import { AuditPage } from './routes/audit.js';
import { ConfigPage } from './routes/config.js';
import { ConflictsPage } from './routes/conflicts.js';
import { LandingPage } from './routes/landing.js';
import { MemoryDetailPage } from './routes/memory-detail.js';
import { MemoryListPage } from './routes/memory.js';
import { SystemPage } from './routes/system.js';

const queryClient = createQueryClient();

/**
 * Subscribes to TanStack's query cache for the lifetime of the
 * tab. Whenever any query (or mutation, via React-Query's
 * unified error path) settles with the synthetic
 * `AUTH_REQUIRED` code, we flip the dashboard into
 * "session-expired" mode: every route is replaced with the
 * uniform `<TokenMissingPanel>` instead of each one rendering
 * its own "failed:" message with a different prefix.
 *
 * Implemented as a hook (rather than a context provider) so the
 * effect lives inside React's lifecycle and unsubscribes on
 * unmount during HMR.
 */
function useAuthGate(): boolean {
  const qc = useQueryClient();
  const [authRequired, setAuthRequired] = useState(false);
  useEffect(() => {
    const queryUnsub = qc.getQueryCache().subscribe((event) => {
      const error = (event.query.state.error ?? null) as { code?: string } | null;
      if (error?.code === AUTH_REQUIRED_CODE) setAuthRequired(true);
    });
    const mutationUnsub = qc.getMutationCache().subscribe((event) => {
      const error = (event.mutation?.state.error ?? null) as { code?: string } | null;
      if (error?.code === AUTH_REQUIRED_CODE) setAuthRequired(true);
    });
    return () => {
      queryUnsub();
      mutationUnsub();
    };
  }, [qc]);
  return authRequired;
}

function AppShell(): JSX.Element {
  const authRequired = useAuthGate();
  return (
    <>
      <Layout>{authRequired ? <TokenMissingPanel /> : <Outlet />}</Layout>
      {authRequired ? null : <CommandPalette />}
    </>
  );
}

const rootRoute = createRootRoute({
  component: AppShell,
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
