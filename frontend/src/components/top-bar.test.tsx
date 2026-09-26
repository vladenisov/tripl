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

  it('says whether the drawer is open and which element it controls (SHELL-21)', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TopBar
            title="Events"
            onOpenMobileNav={() => {}}
            mobileNavOpen
            mobileNavId="app-sidebar"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const trigger = screen.getByRole('button', { name: 'Open navigation' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', 'app-sidebar')
    // The bar is the page's banner landmark (SHELL-47).
    expect(screen.getByRole('banner')).toContainElement(trigger)
  })

  it('sizes its controls as touch targets on phones (SH-16 / AL-41)', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TopBar title="Events" onOpenMobileNav={() => {}} onToggleActivity={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    // jsdom resolves no Tailwind, so the sizes are read off the classes:
    // 40px hamburger and 36px icon buttons below sm, 32px from sm up.
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveClass('h-10', 'w-10', 'sm:h-8')
    expect(screen.getByRole('button', { name: 'Notifications' })).toHaveClass('h-9', 'w-9', 'sm:h-8')
    expect(screen.getByRole('button', { name: 'Command palette' })).toHaveClass('h-9', 'sm:h-8')
    expect(screen.getByRole('button', { name: 'Toggle activity feed' })).toHaveClass('h-9', 'sm:h-8')
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
    // Resolved server-side and carried on the signal, so the bell reads a name
    // off the payload instead of downloading catalogs to find one (tripl-y4wt).
    scope_name: 'Page View',
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

/** The bell asks for the EXPANDED list; a collapsed URL would be the bug. */
const SIGNALS_URL = '/api/v1/projects/demo/anomalies/signals?expanded=true'

function mockNotificationsFetch(signals: unknown[], deliveries: unknown[]) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith(SIGNALS_URL)) {
      return mockJsonResponse(signals)
    }
    if (url.endsWith('/api/v1/projects/demo/alert-deliveries?limit=5')) {
      return mockJsonResponse({ items: deliveries, total: deliveries.length })
    }
    // No branch for the event / event-type / metrics-catalog lookups on purpose:
    // names ride on the signals now, so any such request lands on the throw
    // below rather than being quietly served (tripl-y4wt).
    throw new Error(`Unhandled fetch: ${url}`)
  })
  return calls
}

describe('TopBar notifications', () => {
  it('keeps the bell during a background refresh instead of spinning (SHELL-39)', async () => {
    mockNotificationsFetch([], [])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TopBar title="Events" projectSlug="demo" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const bell = screen.getByRole('button', { name: 'Notifications' })
    const spinner = () => bell.querySelector('[data-testid="notifications-loading"]')
    const refreshDot = () => container.querySelector('[data-testid="notifications-refreshing"]')
    // First load: the spinner stands in for the bell.
    expect(spinner()).not.toBeNull()
    await waitFor(() => expect(spinner()).toBeNull())

    // A background refetch that has not answered yet.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}))
    void queryClient.invalidateQueries()
    await waitFor(() => expect(refreshDot()).not.toBeNull())
    expect(spinner()).toBeNull()
  })

  it('opens real project notifications from signals and alert deliveries', async () => {
    mockNotificationsFetch([mockSignal()], [mockDelivery()])

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    await waitFor(() => {
      expect(screen.getByText('Spike on Event type · Page View')).toBeInTheDocument()
    })
    expect(screen.getByText('Active signals')).toBeInTheDocument()
    expect(screen.getByText('Recent alert deliveries')).toBeInTheDocument()
    expect(screen.getByText('Spike alerts')).toBeInTheDocument()
  })

  it('names non-event scopes for what they are (tripl-jfm3.120)', async () => {
    // The bell's own label function fell through to `event ${ref}`, so once it
    // started reading the expanded list (tripl-jfm3.89) every metric and drift
    // signal was announced as an event.
    mockNotificationsFetch(
      [
        {
          ...mockSignal(),
          scope_type: 'metric',
          scope_ref: 'm1234567-aaaa-bbbb-cccc-dddddddddddd',
          scope_name: 'Checkout conversion',
        },
      ],
      [],
    )

    renderTopBar()
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    await waitFor(() => {
      expect(screen.getByText('Spike on Metric · Checkout conversion')).toBeInTheDocument()
    })
    expect(screen.queryByText(/on Event ·/)).toBeNull()
  })

  it('labels a drop-to-zero signal as "dropped to zero" instead of the clamped z-score', async () => {
    mockNotificationsFetch(
      [{ ...mockSignal(), direction: 'drop', actual_count: 0, expected_count: 80, z_score: -20 }],
      [],
    )

    renderTopBar()

    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    await waitFor(() => {
      expect(screen.getByText('Drop on Event type · Page View')).toBeInTheDocument()
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
      expect(screen.getByText('Spike on Event type · Page View')).toBeInTheDocument()
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

  it('counts event-scope signals, which the collapsed endpoint would have dropped', async () => {
    // tripl-jfm3.89: the bell used the collapsed variant (project_total +
    // event_type only). On prod windy-ios every open signal was event-scope, so
    // an incident with no parent to roll into vanished and the bell read clean
    // while the sidebar and the Anomalies page both showed 30.
    mockNotificationsFetch(
      [
        { ...mockSignal(), scope_type: 'event', scope_ref: 'event-aaaaaaaa', event_id: 'event-aaaaaaaa' },
        { ...mockSignal(), scope_type: 'event', scope_ref: 'event-bbbbbbbb', event_id: 'event-bbbbbbbb' },
      ],
      [],
    )

    renderTopBar()

    expect(
      await screen.findByRole('button', { name: 'Notifications — 2 active' }),
    ).toBeInTheDocument()
  })

  it('applies the shared Significant gate, so the bell equals the sidebar badge', async () => {
    // The sidebar's monitoring_signal_count only counts signals whose relative
    // effect clears 0.5. Counting the raw list here would put a bigger number on
    // the bell than on every other surface — the same disagreement, inverted.
    mockNotificationsFetch(
      [
        { ...mockSignal(), actual_count: 100, expected_count: 20 }, // rel 4.0 → counts
        { ...mockSignal(), scope_ref: 'type-87654321', actual_count: 105, expected_count: 100 }, // rel 0.05 → below
      ],
      [],
    )

    renderTopBar()

    expect(
      await screen.findByRole('button', { name: 'Notifications — 1 active' }),
    ).toBeInTheDocument()
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
      if (url.endsWith(SIGNALS_URL)) {
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

describe('TopBar notifications — scope names (tripl-9tyr, tripl-y4wt)', () => {
  it('names the scope off the signal, fetching no catalog to do it', async () => {
    // The bell used to read "Spike on Event type type-123" while the Overview
    // panel below it read "Event type · Page View" for the very same signal, and
    // it closed that gap by fanning out one GET per event id plus the event-type
    // list and the metrics catalog — every one of them now unhandled here.
    const calls = mockNotificationsFetch([mockSignal()], [])

    renderTopBar()
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    expect(await screen.findByText('Spike on Event type · Page View')).toBeInTheDocument()
    expect(screen.queryByText(/Spike on Event type type-123/)).toBeNull()
    expect(
      calls.filter(u => /\/event-types|\/metrics-catalog|\/events\//.test(u)),
    ).toEqual([])
  })

  it('says an unnameable scope is gone, and keeps its ref in the tooltip only', async () => {
    // A null name is terminal: the entity was deleted (the scope FKs are
    // ondelete=SET NULL), never "still loading". Printing "Event type type-123"
    // instead reads as a name, so the same incident the activity rail calls
    // Page View gets a second, uuid-shaped one.
    mockNotificationsFetch([{ ...mockSignal(), scope_name: null }], [])

    renderTopBar()
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    const row = await screen.findByText('Spike on deleted event type')
    expect(row).toHaveAttribute('title', 'Spike on Event type type-123')
    expect(screen.queryByText(/type-123/)).toBeNull()
  })

  it('keeps a sub-unit baseline instead of rounding it away', async () => {
    // `metric` is a first-class alert scope and a `%` catalog metric stores a
    // fraction (0.08 == 8%), so Math.round printed "vs 0 expected" beside a
    // delta computed from the real baseline (tripl-nj4n).
    mockNotificationsFetch(
      [
        {
          ...mockSignal(),
          scope_type: 'metric',
          scope_name: 'Checkout conversion',
          actual_count: 1.2,
          expected_count: 0.4,
        },
      ],
      [],
    )

    renderTopBar()
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }))

    expect(await screen.findByText(/1\.2 actual vs 0\.4 expected/)).toBeInTheDocument()
    expect(screen.queryByText(/vs 0 expected/)).toBeNull()
  })
})

describe('TopBar naming and phone context (#238 SH-8 / SH-14 / SH-21)', () => {
  function renderPlain(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <TopBar title="Events" onToggleActivity={() => {}} {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('names the feed toggle "Activity", not "Now"', () => {
    renderPlain()
    const toggle = screen.getByRole('button', { name: 'Toggle activity feed' })
    expect(toggle).toHaveTextContent('Activity')
    expect(toggle).not.toHaveTextContent('Now')
  })

  it('shows the project name under the title on phones only', () => {
    renderPlain({ projectName: 'Demo Project 2' })
    expect(screen.getByTestId('topbar-project')).toHaveTextContent('Demo Project 2')
    expect(screen.getByTestId('topbar-project')).toHaveClass('sm:hidden')
  })

  it('keeps the palette trigger only where the sidebar is a drawer', () => {
    renderPlain()
    expect(screen.getByRole('button', { name: 'Command palette' })).toHaveClass('lg:hidden')
  })
})

describe('BranchStrip (#243 PL-1)', () => {
  async function renderStrip(branchId: string | null, setBranchId = vi.fn()) {
    const { BranchStrip } = await import('./top-bar')
    const { BranchContext } = await import('./branch-context-internal')
    const { planBranchesApi } = await import('@/api/planBranches')
    vi.spyOn(planBranchesApi, 'list').mockResolvedValue({
      items: [
        { id: 'main-1', name: 'main', kind: 'main', status: 'merged' },
        { id: 'b-1', name: 'feature/checkout-funnel', kind: 'working', status: 'ready_for_review' },
      ],
      total: 2,
    } as unknown as Awaited<ReturnType<typeof planBranchesApi.list>>)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <BranchContext.Provider value={{ branchId, setBranchId, slug: 'demo' }}>
          <MemoryRouter>
            <BranchStrip slug="demo" />
          </MemoryRouter>
        </BranchContext.Provider>
      </QueryClientProvider>,
    )
    return setBranchId
  }

  it('renders nothing on main', async () => {
    await renderStrip(null)
    expect(screen.queryByTestId('branch-strip')).toBeNull()
  })

  it('names the branch, its status and the ways out', async () => {
    const setBranchId = await renderStrip('b-1')
    const strip = await screen.findByRole('region', { name: 'Plan branch' })
    await waitFor(() => expect(strip).toHaveTextContent('feature/checkout-funnel'))
    expect(strip).toHaveTextContent('Ready for review')
    expect(screen.getByRole('link', { name: 'Review changes' })).toHaveAttribute(
      'href',
      '/p/demo/settings/branches/b-1',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to main' }))
    expect(setBranchId).toHaveBeenCalledWith(null)
  })
})
