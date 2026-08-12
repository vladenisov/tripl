import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertingApi } from '@/api/alerting'
import { metricsApi } from '@/api/metrics'
import { projectsApi } from '@/api/projects'
import Layout from './Layout'

vi.mock('@/api/alerting', () => ({
  alertingApi: { listDeliveries: vi.fn() },
}))

vi.mock('@/api/metrics', () => ({
  metricsApi: { getActiveSignals: vi.fn() },
}))

vi.mock('@/api/projects', () => ({
  // `get` is the confirmation call the shell makes for a slug the list does not
  // know; it must reject the way a real 404 does, not blow up as undefined.
  projectsApi: { list: vi.fn(), get: vi.fn() },
}))

vi.mock('@/components/activity-panel', () => ({
  ActivityPanel: ({ open, slug }: { open: boolean; slug?: string }) =>
    open ? <aside data-testid="activity-panel">Now {slug}</aside> : null,
}))

vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => <nav aria-label="sidebar" />,
}))

vi.mock('@/components/command-palette', () => ({
  CommandPaletteProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/tweaks-panel', () => ({
  TweaksPanelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function renderLayout(
  path: string,
  routePath = '/p/:slug/monitoring/:scope/:id',
  pageLabel = 'Monitoring detail',
) {
  vi.mocked(projectsApi.list).mockResolvedValue([
    {
      id: 'project-1',
      name: 'Demo',
      slug: 'demo',
      description: '',
      app_version_keep_releases: 5,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      summary: {
        event_type_count: 0,
        event_count: 0,
        active_event_count: 0,
        implemented_event_count: 0,
        review_pending_event_count: 0,
        archived_event_count: 0,
        variable_count: 0,
        scan_count: 0,
        firing_monitor_count: 0,
        open_incident_count: 0,
        alert_destination_count: 0,
        alert_rule_count: 0,
        monitoring_signal_count: 0,
        failing_scan_config_count: 0,
        latest_scan_job: null,
        latest_signal: null,
      },
    },
  ])
  vi.mocked(projectsApi.get).mockRejectedValue(new Error('Not found'))
  vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([])
  vi.mocked(alertingApi.listDeliveries).mockResolvedValue({ items: [], total: 0 })

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={<Layout />}>
            <Route index element={<div>{pageLabel}</div>} />
            {/* A splat `routePath` consumes the trailing segments, so the index
                child never matches — give those cases a child that does. */}
            <Route path="*" element={<div>{pageLabel}</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// jsdom has no matchMedia; the rail's inline-vs-drawer choice reads it. Default
// to the narrow branch (no match) so a test opts into wide mode explicitly.
function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
}

beforeEach(() => {
  mockMatchMedia(false)
  if (!globalThis.localStorage) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        store: {} as Record<string, string>,
        getItem(key: string) { return this.store[key] ?? null },
        setItem(key: string, value: string) { this.store[key] = value },
        removeItem(key: string) { delete this.store[key] },
        clear() { this.store = {} },
      },
      configurable: true,
      writable: true,
    })
  }
  localStorage.clear()
  localStorage.setItem('tripl-activity-open', '0')
})

afterEach(() => {
  vi.restoreAllMocks()
  // defineProperty isn't undone by restoreAllMocks — drop the matchMedia stub so
  // it can't leak into other suites under full-suite concurrency.
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('Layout bypass block', () => {
  it('offers a skip link as the first focusable element, targeting main content', async () => {
    const { container } = renderLayout('/p/demo/monitoring/event/event-1')
    await screen.findByText('Monitoring detail')

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skipLink).toHaveAttribute('href', '#main-content')

    // It must come before the sidebar so the very first Tab reaches it.
    const focusable = container.querySelectorAll('a[href], button, input, [tabindex]')
    expect(focusable[0]).toBe(skipLink)

    // …and the target has to be focusable, or the jump goes nowhere.
    const target = container.querySelector('#main-content')
    expect(target).not.toBeNull()
    expect(target).toHaveAttribute('tabindex', '-1')
  })
})

describe('Layout breadcrumbs', () => {
  it('renders no root crumb on the workspace surface (tripl-jfm3.34)', async () => {
    renderLayout('/workspace', '/workspace', 'Workspace dashboard')
    await screen.findByText('Workspace dashboard')

    // The placeholder the crumb resolver used to emit when no project was in
    // scope. It read as an untranslated template leaking into production.
    expect(screen.queryByText('project')).toBeNull()
    expect(screen.getByText('Overview')).toBeInTheDocument()
  })

  it('names the Concepts surface instead of claiming to be Overview (tripl-jfm3.35)', async () => {
    renderLayout('/p/demo/concepts', '/p/:slug/concepts', 'Concepts body')
    await screen.findByText('Concepts body')

    // Concepts sits outside the grouped nav, so it used to fall through to the
    // catch-all and render "Demo › Overview" — a trail pointing at a page the
    // user is not on.
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('Help & reference')).toBeInTheDocument()
    expect(screen.getByText('Concepts')).toBeInTheDocument()
    expect(screen.queryByText('Overview')).toBeNull()
  })

  it('keeps the project crumb but stops claiming "Overview" on an unmatched path', async () => {
    renderLayout('/p/demo/this-route-does-not-exist', '/p/:slug/*', 'Page not found')
    await screen.findByText('Page not found')

    // The slug is valid, so the trail still names the project (tripl-jfm3.3) …
    expect(screen.getByText('Demo')).toBeInTheDocument()
    // … but the page half must not name a real surface the user is not on.
    expect(screen.queryByText('Overview')).toBeNull()
    expect(screen.getByText('Not found')).toBeInTheDocument()
  })
})

describe('Layout unknown project (tripl-jfm3.2)', () => {
  it('renders a not-found state instead of the project shell for an unknown slug', async () => {
    renderLayout('/p/no-such-project-xyz/overview', '/p/:slug/overview', 'Live activity body')

    expect(await screen.findByText('Project not found')).toBeInTheDocument()
    // No shell, so nothing below it can fan out project-scoped requests.
    expect(screen.queryByText('Live activity body')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'sidebar' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Toggle activity panel' })).toBeNull()
    // The invented slug is not echoed back as if it named a workspace.
    expect(screen.getByText(/no project with the address/i)).toBeInTheDocument()
  })

  it('renders the full shell once the slug is confirmed to exist', async () => {
    renderLayout('/p/demo/overview', '/p/:slug/overview', 'Live activity body')

    expect(await screen.findByText('Live activity body')).toBeInTheDocument()
    expect(screen.queryByText('Project not found')).toBeNull()
  })
})

describe('Layout activity panel', () => {
  it('opens Now activity from monitoring detail routes', async () => {
    renderLayout('/p/demo/monitoring/event/event-1')

    expect(await screen.findByText('Monitoring detail')).toBeInTheDocument()
    expect(screen.queryByTestId('activity-panel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity panel' }))

    expect(await screen.findByTestId('activity-panel')).toHaveTextContent('Now demo')
  })

  it('opens the rail as a dismissible drawer on narrow viewports', async () => {
    mockMatchMedia(false)
    renderLayout('/p/demo/monitoring/event/event-1')
    await screen.findByText('Monitoring detail')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity panel' }))
    // Below the breakpoint the rail is an off-canvas drawer with a backdrop.
    expect(await screen.findByTestId('activity-panel')).toBeInTheDocument()
    const backdrop = screen.getByRole('button', { name: 'Close activity feed' })

    fireEvent.click(backdrop)
    expect(screen.queryByTestId('activity-panel')).toBeNull()
  })

  it('renders the rail inline without a backdrop on wide viewports', async () => {
    mockMatchMedia(true)
    renderLayout('/p/demo/monitoring/event/event-1')
    await screen.findByText('Monitoring detail')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity panel' }))
    expect(await screen.findByTestId('activity-panel')).toBeInTheDocument()
    // Inline mode has no drawer backdrop.
    expect(screen.queryByRole('button', { name: 'Close activity feed' })).toBeNull()
  })
})

describe("Layout after a demo is deleted (tripl-jfm3.74)", () => {
  it.each(['/p/demo-gone/events', '/p/demo-gone/anomalies', '/p/demo-gone/overview'])(
    'answers %s with the not-found page and a way out, on every route',
    async (path) => {
      // A deleted demo's URL used to render project chrome, stale event-type
      // navigation and a strip of zeroed stats over "Project not found", plus a
      // pile of raw "Reference: <uuid>" toasts from every failing child query.
      renderLayout(path, '/p/:slug/*', 'Live activity body')

      expect(await screen.findByText('Project not found')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /back to all projects/i })).toBeInTheDocument()
      expect(screen.queryByText('Live activity body')).toBeNull()
      expect(screen.queryByRole('navigation', { name: 'sidebar' })).toBeNull()
    },
  )
})
