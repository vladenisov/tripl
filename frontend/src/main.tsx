import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import './index.css'
import App from './App.tsx'
import { ApiError } from './api/client.ts'
import { ErrorBoundary } from './components/error-boundary.tsx'
import { getErrorMessage } from './lib/utils.ts'

// A 401 triggers the dedicated re-auth flow (see AUTH_UNAUTHORIZED_EVENT); a
// toast there would be noise on top of the redirect.
function surfaceError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    return
  }
  const reference =
    error instanceof ApiError && error.requestId ? `\nReference: ${error.requestId}` : ''
  toast.error(`${getErrorMessage(error)}${reference}`)
}

const queryClient = new QueryClient({
  // Backstop so failed queries/mutations always surface a message — components
  // may still render their own inline error UI in addition to these toasts.
  queryCache: new QueryCache({ onError: surfaceError }),
  mutationCache: new MutationCache({ onError: surfaceError }),
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
