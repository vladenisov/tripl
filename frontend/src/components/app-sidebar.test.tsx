import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
            <Route path="/p/:slug/settings" element={<AppSidebar />} />
            <Route path="/p/:slug/settings/:tab" element={<AppSidebar />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AppSidebar', () => {
  it('renders event views and a settings shortcut for the active project', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
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
              monitoring_signal_count: 2,
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
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const { container } = renderSidebar('/p/demo/events?implemented=false')

    expect(await screen.findByText('All events')).toBeInTheDocument()
    expect(screen.getByText('Needs review')).toBeInTheDocument()
    expect(screen.getByText('Implemented')).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(await screen.findByText('Page view')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getAllByText('3').length).toBeGreaterThan(0)
    expect(container.querySelector('a[href="/p/demo/settings"]')).toBeInTheDocument()
    expect(container.querySelector('a[href="/p/demo/events?implemented=false"]')).toBeInTheDocument()
    expect(container.querySelector('a[href="/p/demo/events/page_view"]')).toBeInTheDocument()
    expect(screen.queryByText('Event Types')).not.toBeInTheDocument()
    expect(screen.queryByText('Alerting')).not.toBeInTheDocument()
    expect(screen.queryByText('Monitoring')).not.toBeInTheDocument()
  })
})
