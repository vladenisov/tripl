import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
