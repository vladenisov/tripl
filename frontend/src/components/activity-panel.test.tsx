import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityPanel } from './activity-panel'

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderActivityPanel(slug?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActivityPanel open slug={slug} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ActivityPanel', () => {
  it('loads project activity from the backend', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/api/v1/activity/projects/demo?limit=20')) {
        return mockJsonResponse([
          {
            id: 'anomaly:1',
            project_id: 'project-1',
            project_slug: 'demo',
            project_name: 'Demo',
            type: 'anomaly',
            severity: 'high',
            title: 'Spike on Page View',
            detail: '42 actual vs 21 expected · z=7.0',
            occurred_at: new Date().toISOString(),
            target_path: '/p/demo/monitoring/event-type/type-1',
          },
        ])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const { container } = renderActivityPanel('demo')

    expect(await screen.findByText('Spike on Page View')).toBeInTheDocument()
    expect(screen.getByText('42 actual vs 21 expected · z=7.0')).toBeInTheDocument()
    expect(container.querySelector('a[href="/p/demo/monitoring/event-type/type-1"]')).toBeInTheDocument()
  })

  it('loads workspace activity when no project slug is present', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/api/v1/activity?limit=20')) {
        return mockJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderActivityPanel()

    expect(await screen.findByText('No recent activity')).toBeInTheDocument()
  })

  it('labels the rail as recent activity rather than a live stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/api/v1/activity/projects/demo?limit=20')) {
        return mockJsonResponse([
          {
            id: 'anomaly:1',
            project_id: 'project-1',
            project_slug: 'demo',
            project_name: 'Demo',
            type: 'anomaly',
            severity: 'high',
            title: 'Spike on Page View',
            detail: '42 actual vs 21 expected · z=7.0',
            occurred_at: new Date().toISOString(),
            target_path: '/p/demo/monitoring/event-type/type-1',
          },
        ])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderActivityPanel('demo')

    expect(await screen.findByText('Recent activity')).toBeInTheDocument()
    // The old copy sold the rail as a live/streaming feed; make sure it is gone.
    expect(screen.queryByText('live')).not.toBeInTheDocument()
    expect(screen.queryByText(/streaming/i)).not.toBeInTheDocument()
    // Item age is surfaced prominently on each row.
    expect(await screen.findByText('just now')).toBeInTheDocument()
  })
})

