import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'

// App routes its pages through `lazy(() => import(...))`, so the first render of a
// route pays to transform and evaluate that page's whole dependency tree — seconds
// of it on a busy machine, and all of it inside whatever `findBy*` timeout the
// assertion happens to have (tripl-gk3l). Importing the pages this file asserts
// text against warms Vite's module cache during collection, so the lazy routes
// resolve from memory instead of racing a timer. The routes stay lazy in the app;
// only the test stops paying the import cost in the middle of an assertion.
import './pages/ProjectsPage'
import './pages/AuthPage'
import './pages/NotFoundPage'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function urlOf(input: RequestInfo | URL) {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
}

const OWNER = {
  id: 'user-1',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'owner',
  created_at: '2026-04-18T10:00:00Z',
  updated_at: '2026-04-18T10:00:00Z',
}

function makeProject(slug: string, name: string) {
  return {
    id: `proj-${slug}`,
    name,
    slug,
    description: '',
    created_at: '2026-04-18T10:00:00Z',
    updated_at: '2026-04-18T10:00:00Z',
    summary: {
      event_type_count: 0,
      event_count: 0,
      active_event_count: 0,
      implemented_event_count: 0,
      review_pending_event_count: 0,
      archived_event_count: 0,
      variable_count: 0,
      scan_count: 0,
      alert_destination_count: 0,
      monitoring_signal_count: 0,
      firing_monitor_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    },
  }
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

    // No projects in this fixture, so the workspace opens on the welcome hero
    // while the footer still renders the signed-in user and sign-out action.
    expect(await screen.findByText('Keep your product analytics honest')).toBeInTheDocument()
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

      if (url.endsWith('/api/v1/auth/status')) {
        return Promise.resolve(jsonResponse({ has_users: true }))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderApp()

    expect(await screen.findByText('Sign in to tripl')).toBeInTheDocument()
    // The register tab ("Create account") is distinct from the submit button.
    expect(screen.getByText('Create account')).toBeInTheDocument()
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
      // The shell resolves `:slug` against this list before it mounts anything
      // project-scoped (tripl-jfm3.2), so the project the URL names has to
      // exist for the routed redirect below it to run at all.
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([makeProject('demo', 'Demo')]))
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

  it('redirects "/" into the single project when exactly one exists', async () => {
    // UX-11 / UX-25: one project ⇒ "/" is a redundant hop, so land directly in
    // that project's overview. Post-redirect page data is irrelevant to the
    // assertion; a 404 lets the overview render its ErrorState rather than crash.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve(jsonResponse(OWNER))
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([makeProject('demo', 'Demo')]))
      }
      return Promise.resolve(jsonResponse({ detail: 'Not found' }, 404))
    })

    renderApp('/')

    await waitFor(() => {
      expect(window.location.pathname).toBe('/p/demo/overview')
    })
  })

  it('keeps "/" on the workspace dashboard when multiple projects exist', async () => {
    // 2+ projects ⇒ the portfolio view is the right landing; no redirect.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve(jsonResponse(OWNER))
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([makeProject('alpha', 'Alpha'), makeProject('beta', 'Beta')]))
      }
      if (url.endsWith('/api/v1/data-sources')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse({ detail: 'Not found' }, 404))
    })

    renderApp('/')

    // The dashboard's always-present header renders, and the URL never bounces.
    expect(await screen.findByText('Analytics workspace')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('redirects "/projects" to the workspace portfolio', async () => {
    // The sidebar/back-links route to the portfolio; "/projects" is a friendly
    // alias that lands on the same all-projects workspace (never bounced).
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve(jsonResponse(OWNER))
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([makeProject('alpha', 'Alpha'), makeProject('beta', 'Beta')]))
      }
      if (url.endsWith('/api/v1/data-sources')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse({ detail: 'Not found' }, 404))
    })

    renderApp('/projects')

    expect(await screen.findByText('Analytics workspace')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.pathname).toBe('/workspace')
    })
  })

  it('renders the not-found page for an unknown authed route', async () => {
    // No catch-all used to leave unmatched paths on a blank screen; the catch-all
    // now renders the app shell + a not-found state with a way back to the portfolio.
    vi.spyOn(globalThis, 'fetch').mockImplementation(authenticatedFetch)

    renderApp('/totally-unknown')

    expect(await screen.findByText('Page not found')).toBeInTheDocument()
    expect(screen.getByText('Back to all projects')).toBeInTheDocument()
    await waitFor(() => {
      expect(document.title).toBe('Page not found · tripl')
    })
  })

  it('keeps the project shell on an unmatched path under a real project (tripl-jfm3.3)', async () => {
    // `/p/demo/<no-such-page>` used to fall through to the GLOBAL catch-all,
    // which declares no `:slug` — so the shell collapsed to "No project
    // selected" and the tab kept the previous page's title.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve(jsonResponse(OWNER))
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([makeProject('demo', 'Demo')]))
      }
      return Promise.resolve(jsonResponse({ detail: 'Not found' }, 404))
    })

    renderApp('/p/demo/this-route-does-not-exist')

    expect(await screen.findByText('Page not found')).toBeInTheDocument()
    // The project is still in scope: its name heads the breadcrumb trail.
    expect(screen.getAllByText('Demo').length).toBeGreaterThan(0)
    await waitFor(() => {
      expect(document.title).toBe('Page not found · demo · tripl')
    })
  })

  it('shows a not-found state for an unknown project slug without fanning out (tripl-jfm3.2)', async () => {
    // An invented slug used to render a complete, working-looking project shell
    // backed by a dozen 404ing project-scoped requests, with the bogus slug
    // echoed into the document title.
    const requested: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input)
      requested.push(url)
      if (url.endsWith('/api/v1/auth/me')) return Promise.resolve(jsonResponse(OWNER))
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([makeProject('demo', 'Demo')]))
      }
      return Promise.resolve(jsonResponse({ detail: 'Not found' }, 404))
    })

    renderApp('/p/no-such-project-xyz/overview')

    expect(await screen.findByText('Project not found')).toBeInTheDocument()
    // Exactly ONE request names the bogus slug — the confirmation that decides
    // the project does not exist. No event-types / signals / branches / stream /
    // activity fan-out behind a shell that was never going to work.
    const scoped = [...new Set(requested.filter((u) => u.includes('no-such-project-xyz')))]
    expect(scoped).toEqual(['/api/v1/projects/no-such-project-xyz'])
    // …and the invented slug is not echoed back as if it named a workspace.
    await waitFor(() => {
      expect(document.title).toBe('Page not found · tripl')
    })
  })
})
