import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MonitorDetailPage from './MonitorDetailPage'
import { formatCooldown } from './alerting/constants'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const BASE_MONITOR = {
  rule_id: 'rule-1',
  rule_name: 'payment_failed spike',
  destination_id: 'dest-1',
  destination_name: 'Main Slack',
  destination_type: 'slack',
  enabled: true,
  status: 'firing',
  active_scope_count: 2,
  firing_scope_count: 1,
  last_anomaly_at: '2026-06-26T10:00:00Z',
  last_notified_at: '2026-06-26T10:01:00Z',
  notify_on_spike: true,
  notify_on_drop: false,
  min_percent_delta: 50,
  min_expected_count: 100,
  // 360 is the value from tripl-oxkt.18: the monitors side used to print it raw
  // as "360m" while the alerting side already said "6h" for the same rule.
  cooldown_minutes: 360,
  muted: false,
  muted_until: null,
  rule_enabled: true,
  destination_enabled: true,
  include_project_total: true,
  include_event_types: true,
  include_events: false,
  include_schema_drifts: false,
  include_distribution_drifts: false,
  include_release_regressions: false,
  total_deliveries: 3,
  last_delivery_at: '2026-06-26T10:01:00Z',
  last_delivery_status: 'sent',
}

const HISTORY = {
  items: [
    {
      id: 'del-1',
      project_id: 'proj-1',
      scan_config_id: 'scan-1',
      scan_job_id: 'job-1',
      destination_id: 'dest-1',
      rule_id: 'rule-1',
      destination_name: 'Main Slack',
      rule_name: 'payment_failed spike',
      scan_name: 'hourly events scan',
      status: 'failed',
      channel: 'slack',
      matched_count: 4,
      payload_snapshot: null,
      error_message: 'Scan failed: could not connect to the data source.',
      created_at: '2026-06-26T10:01:00Z',
      updated_at: '2026-06-26T10:01:00Z',
      sent_at: null,
    },
  ],
  total: 1,
}

type MockOptions = {
  monitor?: Record<string, unknown>
  muteResponse?: Record<string, unknown>
}

function mockApi(options: MockOptions = {}) {
  const monitor = options.monitor ?? BASE_MONITOR
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('/alert-deliveries')) return jsonResponse(HISTORY)
    if (url.includes('/monitors/rule-1/mute')) {
      return jsonResponse(options.muteResponse ?? { ...monitor, muted: true, muted_until: '2099-01-01T00:00:00Z' })
    }
    if (url.includes('/monitors/rule-1/unmute')) {
      return jsonResponse({ ...monitor, muted: false, muted_until: null })
    }
    if (url.includes('/monitors/rule-1') && method === 'GET') return jsonResponse(monitor)
    throw new Error(`Unhandled fetch: ${method} ${url}`)
  })
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/monitors/rule-1']}>
        <Routes>
          <Route path="/p/:slug/monitors/:monitorId" element={<MonitorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** One hour, as the shared preset list defines it. */
const HOUR_MS = 3_600_000

describe('MonitorDetailPage', () => {
  it('renders the monitor condition, destination, recency and fired history', async () => {
    mockApi()

    renderDetail()

    expect(await screen.findByRole('heading', { name: 'payment_failed spike' })).toBeInTheDocument()
    // Condition config
    expect(screen.getByText('Spike ▲')).toBeInTheDocument()
    expect(screen.getByText('≥ 50% change')).toBeInTheDocument()
    expect(screen.getByText('6h between alerts')).toBeInTheDocument()
    expect(screen.getByText('Project total')).toBeInTheDocument()
    // Routing destination + recency
    expect(screen.getByText('Main Slack')).toBeInTheDocument()
    expect(screen.getByText('Last fired')).toBeInTheDocument()
    // Fired-history timeline surfaces this rule's deliveries
    expect(await screen.findByText('hourly events scan')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(
      screen.getByText('Scan failed: could not connect to the data source.'),
    ).toBeInTheDocument()
    // Back link to the monitors list
    expect(screen.getByRole('link', { name: 'Monitors' })).toHaveAttribute(
      'href',
      '/p/demo/monitors',
    )
  })

  // Pins the unit agreement from tripl-oxkt.18: this page and the alerting
  // destinations card described one rule's cooldown two different ways ("360m"
  // vs "6h"). Asserting against `formatCooldown` itself — the helper the
  // alerting side already renders — means the two screens cannot drift apart
  // again without this failing.
  // 90 stays in minutes because it is not a whole number of hours; 1 is the
  // smallest cooldown the API accepts (`ge=1`), so 0 is unreachable here.
  it.each([
    [1, '1m'],
    [30, '30m'],
    [60, '1h'],
    [90, '90m'],
    [360, '6h'],
    [1440, '1d'],
  ])('renders a %i-minute cooldown as "%s between alerts"', async (minutes, expected) => {
    expect(formatCooldown(minutes)).toBe(expected)
    mockApi({ monitor: { ...BASE_MONITOR, cooldown_minutes: minutes } })

    renderDetail()

    await screen.findByRole('heading', { name: 'payment_failed spike' })
    expect(screen.getByText(`${expected} between alerts`)).toBeInTheDocument()
  })

  it('never prints a raw minute count once the formatter has a coarser unit', async () => {
    mockApi({ monitor: { ...BASE_MONITOR, cooldown_minutes: 360 } })

    renderDetail()

    await screen.findByRole('heading', { name: 'payment_failed spike' })
    expect(screen.queryByText('360m between alerts')).toBeNull()
  })

  it('mutes the monitor for a preset duration, at the exact instant that preset means', async () => {
    const fetchMock = mockApi()

    renderDetail()

    await screen.findByRole('heading', { name: 'payment_failed spike' })

    // The clock is pinned across the click only. This page used to own a
    // private `futureIso` beside a private copy of the preset list; the rewire
    // onto the shared `muteUntilIso` (tripl-es0f) is only behaviour-preserving
    // if the instant is identical, so assert the instant rather than merely
    // "some time in the future" — which would also pass if the wrong number
    // were passed in, or the label, or an already-absolute timestamp.
    const clickedAt = Date.parse('2026-08-14T10:00:00Z')
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(clickedAt)
    fireEvent.click(screen.getByRole('button', { name: '1h' }))
    nowSpy.mockRestore()

    await waitFor(() => {
      const muteCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/mute'))
      expect(muteCall).toBeTruthy()
      const body = JSON.parse(String((muteCall?.[1] as RequestInit).body)) as { muted_until: string }
      expect(body.muted_until).toBe(new Date(clickedAt + HOUR_MS).toISOString())
    })

    // After a successful mute the control flips to Unmute.
    expect(await screen.findByRole('button', { name: 'Unmute' })).toBeInTheDocument()
  })

  it('offers the shared presets, and only those (tripl-es0f, tripl-a50u)', async () => {
    mockApi()

    renderDetail()

    await screen.findByRole('heading', { name: 'payment_failed spike' })

    // The three the shared module defines, unrenamed and unreordered — this is
    // what stops the rewire from quietly dropping or relabelling one.
    for (const label of ['1h', '24h', '7d']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    // …and no open-ended mute. A rule with a NULL `muted_until` is NOT muted
    // (`is_rule_muted`), so that button would do the opposite of its label here;
    // the permanent lever on a rule is the enable/disable switch.
    expect(screen.queryByRole('button', { name: /until unmuted/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Until I unmute/i })).toBeNull()
  })

  it('shows an unmute control for an already-muted monitor', async () => {
    mockApi({ monitor: { ...BASE_MONITOR, muted: true, muted_until: '2099-01-01T00:00:00Z' } })

    renderDetail()

    expect(await screen.findByRole('button', { name: 'Unmute' })).toBeInTheDocument()
    expect(screen.getByText(/Muted until/)).toBeInTheDocument()
  })

  it('renders an error state when the monitor cannot be loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/alert-deliveries')) return jsonResponse(HISTORY)
      return jsonResponse({ detail: 'Not found' }, 404)
    })

    renderDetail()

    // "Rule", not "Monitor": the second noun for one object went with the
    // standalone list it named (tripl-89ps).
    expect(await screen.findByText('Rule unavailable')).toBeInTheDocument()
  })
})
