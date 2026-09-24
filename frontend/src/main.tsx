import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/error-boundary.tsx'
import { surfaceMutationError, surfaceQueryError } from './lib/errorFeedback.ts'

const queryClient = new QueryClient({
  // Backstop so a failure nobody renders still surfaces a message. A query or
  // mutation that shows its own error opts out with `meta: SILENT_ERROR_META`;
  // see lib/errorFeedback.ts for the rest of the policy.
  queryCache: new QueryCache({ onError: surfaceQueryError }),
  mutationCache: new MutationCache({ onError: surfaceMutationError }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Default cache policy: data is fresh for 60s, GC'd 5 min after unmount.
      // Per-query overrides: longer for event types/meta fields (rarely change),
      // shorter (or refetchInterval) for live metrics and monitoring signals.
      staleTime: 60_000,
      gcTime: 5 * 60_000,
    },
  },
})

/**
 * A DATA router, so `useBlocker` exists — and one catch-all route, so nothing
 * else has to change.
 *
 * The settings takeover guards unsaved drafts on every in-app exit and on
 * reload, but could not guard the browser Back button: a blocker is the only
 * thing that sees a navigation BEFORE it commits, and a plain `BrowserRouter`
 * offers none. The alternative — park a spare history entry and read popstate —
 * was built and pulled, because a settings move the draft survives buries the
 * parked entry and every repair for that opened another hole (tripl-l33u.14).
 *
 * The route table stays in `App.tsx` exactly as it is. `RouterProvider` puts a
 * data-router context above the whole tree, and a descendant `<Routes>`
 * navigates through `router.navigate` all the same, so every navigation in the
 * app is blocker-visible while all 63 route elements keep their current shape.
 * Migrating them to `createRoutesFromElements` would move the provider stack
 * into a layout route and rewrite every test that mounts the app, and buy
 * nothing this needs.
 *
 * `QueryClientProvider` stays OUTSIDE: no route uses a loader, so nothing in the
 * router asks for it before render.
 */
const router = createBrowserRouter([{ path: '*', element: <App /> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
