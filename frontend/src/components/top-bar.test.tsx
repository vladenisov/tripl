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

type DeliveryOverrides = {
  id?: string
  rule_name?: string
  status?: 'pending' | 'sent' | 'failed'
  error_message?: string | null
}

function mockSignal() {
  return {
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
  }
}

function mockDelivery(overrides: DeliveryOverrides = {}) {
  return {
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
    ...overrides,
  }
}

function mockNotificationsFetch(signals: unknown[], deliveries: unknown[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.endsWith('/api/v1/projects/demo/anomalies/signals')) {
      return mockJsonResponse(signals)
    }
    if (url.endsWith('/api/v1/projects/demo/alert-deliveries?limit=5')) {
      return mockJsonResponse({ items: deliveries, total: deliveries.length })
    }
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

describe('TopBar notifications', () => {
  it('opens real project notifications from signals and alert deliveries', async () => {
    mockNotificationsFetch([mockSignal()], [mockDelivery()])

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    await waitFor(() => {
      expect(screen.getByText('Spike on event type type-123')).toBeInTheDocument()
    })
    expect(screen.getByText('Active Signals')).toBeInTheDocument()
    expect(screen.getByText('Recent Alert Deliveries')).toBeInTheDocument()
    expect(screen.getByText('Spike alerts')).toBeInTheDocument()
  })

  it('labels a drop-to-zero signal as "dropped to zero" instead of the clamped z-score', async () => {
    mockNotificationsFetch(
      [{ ...mockSignal(), direction: 'drop', actual_count: 0, expected_count: 80, z_score: -20 }],
      [],
    )

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    await waitFor(() => {
      expect(screen.getByText('Drop on event type type-123')).toBeInTheDocument()
    })
    // The zeroed drop reads "dropped to zero"; the repeated clamped z is hidden.
    expect(screen.getByText(/dropped to zero/)).toBeInTheDocument()
    expect(screen.queryByText(/z=-20/)).toBeNull()
  })

  it('header "N active" equals the active signals list length, never signals + deliveries', async () => {
    // 1 active signal + 1 (failed) delivery. Old bug summed these to "2 active".
    mockNotificationsFetch([mockSignal()], [mockDelivery({ status: 'failed' })])

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    await waitFor(() => {
      expect(screen.getByText('Spike on event type type-123')).toBeInTheDocument()
    })
    // Header reads 1 active (signals.length), not 2 (signals + delivery).
    expect(screen.getByText('1 active')).toBeInTheDocument()
    expect(screen.queryByText('2 active')).toBeNull()
    // Bell aria-label is bound to the same active-signal count.
    expect(
      screen.getByRole('button', { name: 'Notifications — 1 active' }),
    ).toBeInTheDocument()
  })

  it('does not report deliveries as "active" when there are no open signals (H1 regression)', async () => {
    // Canonical H1 scenario: 0 signals + 1 pending delivery must NOT read "1 active".
    mockNotificationsFetch([], [mockDelivery({ status: 'pending', error_message: null })])

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))

    // The delivery is still listed as history once it loads.
    await waitFor(() => {
      expect(screen.getByText('Spike alerts')).toBeInTheDocument()
    })
    expect(screen.getByText('No active monitoring signals.')).toBeInTheDocument()
    // No "active" indicator at all — header span and bell badge are both hidden.
    expect(screen.queryByText(/\d+ active/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
  })

  it('surfaces a failed-delivery count badge distinct from the active count', async () => {
    mockNotificationsFetch([], [mockDelivery({ status: 'failed' })])

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))

    // Failed deliveries are visibly distinguished without being counted as active.
    await waitFor(() => {
      expect(screen.getByText('1 failed')).toBeInTheDocument()
    })
    expect(screen.queryByText(/\d+ active/)).toBeNull()
  })

  it('offers a compact retry control only on failed delivery notifications', async () => {
    mockNotificationsFetch(
      [],
      [
        mockDelivery({ id: 'd-failed', rule_name: 'Failing rule', status: 'failed' }),
        mockDelivery({ id: 'd-sent', rule_name: 'Healthy rule', status: 'sent', error_message: null }),
      ],
    )

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry delivery for Failing rule' })).toBeInTheDocument()
    })
    // The healthy (sent) delivery exposes no retry affordance.
    expect(screen.queryByRole('button', { name: 'Retry delivery for Healthy rule' })).toBeNull()
  })

  it('retries a failed delivery from the notifications menu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/anomalies/signals')) {
        return mockJsonResponse([])
      }
      if (url.endsWith('/api/v1/projects/demo/alert-deliveries?limit=5')) {
        return mockJsonResponse({ items: [mockDelivery({ status: 'failed' })], total: 1 })
      }
      if (url.endsWith('/alert-deliveries/delivery-1/retry') && init?.method === 'POST') {
        return mockJsonResponse({ ...mockDelivery({ status: 'pending', error_message: null }), items: [] })
      }
      throw new Error(`Unhandled fetch: ${init?.method} ${url}`)
    })

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))

    const retryButton = await screen.findByRole('button', { name: 'Retry delivery for Spike alerts' })
    fireEvent.click(retryButton)

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/v1/projects/demo/alert-deliveries/delivery-1/retry',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})
