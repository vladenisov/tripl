import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeneralTab } from './GeneralTab'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const PROJECT = {
  id: 'project-1',
  name: 'Demo',
  slug: 'demo',
  description: 'A demo project',
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
    alert_destination_count: 0,
    monitoring_signal_count: 0,
    latest_scan_job: null,
    latest_signal: null,
  },
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/settings/general']}>
        <GeneralTab slug="demo" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GeneralTab', () => {
  it('exposes an in-project Delete project action (danger zone)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderTab()

    expect(await screen.findByRole('button', { name: /Delete project/ })).toBeInTheDocument()
  })
})
