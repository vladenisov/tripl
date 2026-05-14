import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from './top-bar'

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderTopBar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TopBar title="Events" projectSlug="demo" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TopBar mobile nav', () => {
  function renderWithMobileNav(onOpen?: () => void) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TopBar title="Events" projectSlug="demo" onOpenMobileNav={onOpen} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('renders the mobile nav trigger only when an onOpenMobileNav prop is given', () => {
    const { rerender } = renderWithMobileNav(undefined)
    expect(screen.queryByLabelText('Open navigation')).toBeNull()

    const onOpen = vi.fn()
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TopBar title="Events" projectSlug="demo" onOpenMobileNav={onOpen} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByLabelText('Open navigation'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('TopBar notifications', () => {
  it('opens real project notifications from signals and alert deliveries', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/anomalies/signals')) {
        return mockJsonResponse([
          {
            scan_config_id: 'scan-1',
            scope_type: 'event_type',
            scope_ref: 'type-12345678',
            state: 'latest_scan',
            event_id: null,
            event_type_id: 'type-12345678',
            bucket: '2026-01-01T00:00:00Z',
            actual_count: 42,
            expected_count: 21,
            stddev: 3,
            z_score: 7,
            direction: 'spike',
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/alert-deliveries?limit=5')) {
        return mockJsonResponse({
          items: [
            {
              id: 'delivery-1',
              project_id: 'project-1',
              scan_config_id: 'scan-1',
              scan_job_id: null,
              destination_id: 'destination-1',
              rule_id: 'rule-1',
              destination_name: 'Ops',
              rule_name: 'Spike alerts',
              scan_name: 'Main scan',
              status: 'failed',
              channel: 'slack',
              matched_count: 1,
              payload_snapshot: null,
              error_message: 'Webhook failed',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              sent_at: null,
            },
          ],
          total: 1,
        })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderTopBar()

    fireEvent.click(screen.getByTitle('Notifications'))

    await waitFor(() => {
      expect(screen.getByText('Spike on event type type-123')).toBeInTheDocument()
    })
    expect(screen.getByText('Active Signals')).toBeInTheDocument()
    expect(screen.getByText('Recent Alert Deliveries')).toBeInTheDocument()
    expect(screen.getByText('Spike alerts')).toBeInTheDocument()
  })
})
