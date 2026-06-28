import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from './auth-context'
import { AppSidebar } from './app-sidebar'

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const authValue: AuthContextValue = {
  user: {
    id: 'user-1',
    email: 'owner@example.com',
    name: 'Owner',
    role: 'owner',
    created_at: '2026-04-18T10:00:00Z',
    updated_at: '2026-04-18T10:00:00Z',
  },
  status: 'authenticated',
  error: null,
  isLoggingOut: false,
  logout: async () => {},
  refresh: () => {},
}

function mockProjectsFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith('/api/v1/projects')) {
      return mockJsonResponse([
        {
          id: 'project-1',
          name: 'Demo',
          slug: 'demo',
          description: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          summary: {
            event_type_count: 2,
            event_count: 13,
            active_event_count: 10,
            implemented_event_count: 7,
            review_pending_event_count: 3,
            archived_event_count: 2,
            variable_count: 5,
            scan_count: 4,
            alert_destination_count: 1,
            // H1: monitoring_signal_count is the OPEN-SIGNAL population (anomalies
            // across project_total + event_type + event scope). It must NOT drive
            // the "Monitors" nav badge, which counts MONITOR configs needing
            // attention. firing_monitor_count is the canonical source for that badge.
            monitoring_signal_count: 9,
            firing_monitor_count: 3,
            latest_scan_job: null,
            latest_signal: null,
          },
        },
      ])
    }
    if (url.endsWith('/api/v1/projects/demo/event-types')) {
      return mockJsonResponse([
        {
          id: 'event-type-1',
          project_id: 'project-1',
          name: 'page_view',
          display_name: 'Page view',
          description: '',
          color: '#3b82f6',
          order: 0,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          field_definitions: [],
        },
        {
          id: 'event-type-2',
          project_id: 'project-1',
          name: 'track_click',
          display_name: 'Track click',
          description: '',
          color: '#f97316',
          order: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          field_definitions: [],
        },
      ])
    }
    if (url.endsWith('/api/v1/projects/demo/branches')) {
      return mockJsonResponse({
        items: [
          {
            id: 'branch-main',
            project_id: 'project-1',
            name: 'main',
            kind: 'main',
            status: 'merged',
            description: '',
            base_revision_id: null,
            created_by: null,
            merged_at: null,
            merged_by: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      })
    }
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderSidebar(initialEntry = '/p/demo/events') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/p/:slug/events" element={<AppSidebar />} />
            <Route path="/p/:slug/events/:tab" element={<AppSidebar />} />
            <Route path="/p/:slug/events/:tab/:eventId" element={<AppSidebar />} />
            <Route path="/p/:slug/settings" element={<AppSidebar />} />
            <Route path="/p/:slug/settings/:tab" element={<AppSidebar />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AppSidebar', () => {
  it('renders the job-based navigation groups for the active project', async () => {
    mockProjectsFetch()

    renderSidebar('/p/demo/events')

    // Await the projects query so the active project (and its counts) resolve.
    expect(await screen.findByText('Events')).toBeInTheDocument()
    expect(await screen.findByText('Page view')).toBeInTheDocument()

    for (const group of ['Plan', 'Observe', 'Govern']) {
      expect(screen.getByText(group)).toBeInTheDocument()
    }
    for (const item of [
      'Events',
      'Event types',
      'Page view',
      'Track click',
      'Schema & fields',
      'Plan branches',
      'Live activity',
      'Monitors',
      'Anomalies',
      'Alerting',
      'Reconciliation',
      'Coverage',
      'Scans',
      'Audit log',
    ]) {
      expect(screen.getByText(item)).toBeInTheDocument()
    }
  })

  it('points each nav item at its first-class route', async () => {
    mockProjectsFetch()

    const { container } = renderSidebar('/p/demo/events')
    await screen.findByText('Events')
    await screen.findByText('Page view')

    const expected: Record<string, string> = {
      Events: '/p/demo/events',
      'Live activity': '/p/demo/overview',
      'Schema & fields': '/p/demo/settings/meta-fields',
      'Plan branches': '/p/demo/settings/branches',
      Monitors: '/p/demo/monitors',
      Anomalies: '/p/demo/anomalies',
      Alerting: '/p/demo/settings/alerting',
      Reconciliation: '/p/demo/reconciliation',
      Coverage: '/p/demo/coverage',
      Scans: '/p/demo/settings/scans',
      'Audit log': '/p/demo/settings/audit',
    }
    for (const [label, href] of Object.entries(expected)) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toHaveAttribute('href', href)
    }
    expect(screen.getByRole('link', { name: 'Page view' })).toHaveAttribute('href', '/p/demo/events/page_view')
    expect(screen.getByRole('link', { name: 'Track click' })).toHaveAttribute('href', '/p/demo/events/track_click')
    expect(screen.getByRole('link', { name: 'Event type settings' })).toHaveAttribute(
      'href',
      '/p/demo/settings/event-types',
    )
    // Footer: workspace + project settings now point at the full-takeover area.
    expect(container.querySelector('a[href="/settings"]')).toBeInTheDocument()
    expect(container.querySelector('a[href="/settings/project/general"]')).toBeInTheDocument()
  })

  it('marks the active event type link based on the current route', async () => {
    mockProjectsFetch()

    renderSidebar('/p/demo/events/page_view')
    const eventTypeLink = await screen.findByRole('link', { name: 'Page view' })
    expect(eventTypeLink).toHaveStyle({ background: 'var(--surface-hover)' })
  })

  it('surfaces project-summary counts including the firing-monitor count on Monitors', async () => {
    mockProjectsFetch()

    renderSidebar('/p/demo/events')
    // The nav labels render from the URL slug immediately; counts only appear
    // once the projects query resolves the active project's summary.
    await screen.findByText('10')

    // Events active count (10), event-type count (2) and alerting destinations (1)
    // are unambiguous project-summary stats and always render as nav badges.
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()

    // H1: the "Monitors" nav item counts MONITORS in a firing state
    // (firing_monitor_count === 3), equal to the Monitors page firing_count — so
    // it surfaces "3" and never the open-signal population
    // (monitoring_signal_count === 9 here).
    const monitorsLink = screen.getByRole('link', { name: /Monitors/ })
    expect(monitorsLink).toHaveTextContent('3')
    expect(monitorsLink).not.toHaveTextContent('9')

    // The Anomalies item is the counterpart: it badges the open-signal
    // population (monitoring_signal_count === 9), not the firing-monitor count.
    const anomaliesLink = screen.getByRole('link', { name: /Anomalies/ })
    expect(anomaliesLink).toHaveTextContent('9')
    expect(anomaliesLink).not.toHaveTextContent('3')
  })

  it('surfaces Variables and Relations as discoverable Plan nav items (M6)', async () => {
    mockProjectsFetch()

    renderSidebar('/p/demo/events')
    await screen.findByText('Events')

    // M6: Variables and Relations must be reachable from the sidebar (not only
    // via the command palette), pointing at their project-scoped settings routes.
    const variables = await screen.findByRole('link', { name: /Variables/ })
    expect(variables).toHaveAttribute('href', '/p/demo/settings/variables')
    const relations = screen.getByRole('link', { name: /Relations/ })
    expect(relations).toHaveAttribute('href', '/p/demo/settings/relations')
  })

  it('marks the active surface based on the current route', async () => {
    mockProjectsFetch()

    renderSidebar('/p/demo/settings/monitoring')
    const monitors = await screen.findByRole('link', { name: /Monitors/ })
    expect(monitors).toHaveStyle({ background: 'var(--surface-hover)' })
  })
})
