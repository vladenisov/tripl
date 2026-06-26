import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderApp(path = '/') {
  window.history.pushState({}, '', path)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>,
  )
}

function authenticatedFetch(input: RequestInfo | URL) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

  if (url.endsWith('/api/v1/auth/me')) {
    return Promise.resolve(jsonResponse({
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Owner',
      role: 'owner',
      created_at: '2026-04-18T10:00:00Z',
      updated_at: '2026-04-18T10:00:00Z',
    }))
  }

  if (url.endsWith('/api/v1/projects')) {
    return Promise.resolve(jsonResponse([]))
  }

  return Promise.reject(new Error(`Unexpected request: ${url}`))
}

describe('App', () => {
  beforeEach(() => {
    if (!window.localStorage) {
      Object.defineProperty(window, 'localStorage', {
        value: {
          store: {} as Record<string, string>,
          getItem(key: string) { return this.store[key] ?? null },
          setItem(key: string, value: string) { this.store[key] = value },
          removeItem(key: string) { delete this.store[key] },
          clear() { this.store = {} },
        },
        writable: true,
      })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.pushState({}, '', '/')
  })

  it('renders the tripl brand for authenticated users', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(authenticatedFetch)

    renderApp()

    expect(await screen.findByText('tripl')).toBeInTheDocument()
  })

  it('renders the sidebar navigation and signed-in user', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(authenticatedFetch)

    renderApp()

    // No projects in this fixture, so the grouped nav shows its empty state
    // while the footer still renders the signed-in user and sign-out action.
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('redirects anonymous users to the auth page', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/auth/me')) {
        return Promise.resolve(jsonResponse({ detail: 'Authentication required' }, 401))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderApp()

    expect(await screen.findByText('Sign in to tripl')).toBeInTheDocument()
    expect(screen.getByText('Create Account')).toBeInTheDocument()
  })

  it('redirects the legacy event-detail URL to the canonical monitoring route', async () => {
    // B1: the legacy `/events/detail/:eventId` route used to mount the detail
    // page with no `:scope` and crash. It now redirects to the canonical URL.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/auth/me')) {
        return Promise.resolve(jsonResponse({
          id: 'user-1',
          email: 'owner@example.com',
          name: 'Owner',
          role: 'owner',
          created_at: '2026-04-18T10:00:00Z',
          updated_at: '2026-04-18T10:00:00Z',
        }))
      }
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([]))
      }
      // Detail-page data is irrelevant to the redirect assertion; a 404 makes
      // the page render its ErrorState gracefully rather than crash.
      return Promise.resolve(jsonResponse({ detail: 'Not found' }, 404))
    })

    renderApp('/p/demo/events/detail/event-1')

    await waitFor(() => {
      expect(window.location.pathname).toBe('/p/demo/monitoring/event/event-1')
    })
  })
})
