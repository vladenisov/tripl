import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import ProjectsPage from './ProjectsPage'

function authValue(role: 'owner' | 'editor' | 'viewer'): AuthContextValue {
  return {
    user: {
      id: `${role}-1`,
      email: `${role}@example.com`,
      name: role,
      role,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: async () => {},
    refresh: () => {},
  }
}

function renderProjectsPage(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue(role)}>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ProjectsPage', () => {
  it('shows portfolio metrics and project summaries', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'proj-1',
            name: 'Alpha',
            slug: 'alpha',
            description: 'Landing coverage and funnel events.',
            created_at: '2026-04-01T09:00:00Z',
            updated_at: '2026-04-10T09:00:00Z',
            summary: {
              event_type_count: 3,
              event_count: 8,
              active_event_count: 6,
              implemented_event_count: 4,
              review_pending_event_count: 2,
              archived_event_count: 2,
              variable_count: 5,
              scan_count: 2,
              alert_destination_count: 1,
              monitoring_signal_count: 2,
              latest_scan_job: {
                id: 'job-1',
                scan_config_id: 'scan-1',
                scan_name: 'Production scan',
                status: 'completed',
                started_at: '2026-04-10T08:00:00Z',
                completed_at: '2026-04-10T08:05:00Z',
                result_summary: {
                  events_created: 4,
                  signals_added: 2,
                  alerts_queued: 1,
                },
                error_message: null,
                created_at: '2026-04-10T08:05:00Z',
              },
              latest_signal: {
                scan_config_id: 'scan-1',
                scan_name: 'Production scan',
                scope_type: 'event_type',
                scope_ref: 'type-1',
                scope_name: 'Page View',
                state: 'latest_scan',
                bucket: '2026-04-10T08:00:00Z',
                actual_count: 42,
                expected_count: 21,
                z_score: 7,
                direction: 'spike',
              },
            },
          },
        ]))
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'ds-1',
            name: 'Warehouse',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'analytics',
            username: 'default',
            password_set: false,
            extra_params: null,
            created_at: '2026-04-01T09:00:00Z',
            updated_at: '2026-04-10T09:00:00Z',
          },
        ]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderProjectsPage()

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Analytics workspace')).toBeInTheDocument()
    expect(screen.getByText('Project portfolio')).toBeInTheDocument()
    expect(screen.getByText('Landing coverage and funnel events.')).toBeInTheDocument()
    expect(screen.getByText('67% implemented')).toBeInTheDocument()
    expect(screen.getByText('2 pending review')).toBeInTheDocument()
    expect(screen.getByText('Latest scan')).toBeInTheDocument()
    expect(screen.getByText('Production scan')).toBeInTheDocument()
    expect(screen.getByText('Latest scan signal')).toBeInTheDocument()
    expect(screen.getByText('Page View')).toBeInTheDocument()
    expect(screen.getByText('2 active')).toBeInTheDocument()
    expect(screen.getByText('Open Signal')).toBeInTheDocument()
    expect(screen.getByText('Open Project')).toBeInTheDocument()
  })

  it('hides project deletion from editors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'proj-1',
            name: 'Alpha',
            slug: 'alpha',
            description: '',
            created_at: '2026-04-01T09:00:00Z',
            updated_at: '2026-04-10T09:00:00Z',
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
              latest_scan_job: null,
              latest_signal: null,
            },
          },
        ]))
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderProjectsPage('editor')

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete Alpha/i })).not.toBeInTheDocument()
  })

  it('shows an error instead of the empty state when the backend is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    renderProjectsPage()

    expect(await screen.findByText('Failed to load projects')).toBeInTheDocument()
    expect(screen.getByText('Backend is unavailable. Check that the API server is running and try again.')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
  })
})
