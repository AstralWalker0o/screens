import { createBrowserRouter, Outlet, type RouteObject } from 'react-router';
import type { ComponentType } from 'react';
import { AppShell } from './layout/AppShell';
import { RouteError, NotFound } from './pages/NotFound';

// Each page is its own chunk, loaded on first visit.
const page = (load: () => Promise<{ default: ComponentType }>): RouteObject['lazy'] => async () => ({ Component: (await load()).default });

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      {
        element: <Outlet />,
        errorElement: <RouteError />,
        children: [
          { index: true, lazy: page(() => import('./pages/Overview')) },
          { path: 'sites', lazy: page(() => import('./pages/Sites')) },
          { path: 'sites/:id/:tab?', lazy: page(() => import('./pages/site/SiteDetail')) },
          { path: 'devices', lazy: page(() => import('./pages/Devices')) },
          { path: 'devices/:id/:tab?', lazy: page(() => import('./pages/device/DeviceDetail')) },
          { path: 'privacy', lazy: page(() => import('./pages/Privacy')) },
          { path: 'dns/:tab?', lazy: page(() => import('./pages/Dns')) },
          { path: 'automations', lazy: page(() => import('./pages/Automations')) },
          { path: 'automations/:id', lazy: page(() => import('./pages/AutomationEditor')) },
          { path: 'library/:tab?', lazy: page(() => import('./pages/Library')) },
          { path: 'activity/:tab?', lazy: page(() => import('./pages/Activity')) },
          { path: 'settings', lazy: page(() => import('./pages/Settings')) },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
