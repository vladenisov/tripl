import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { alertingApi } from '@/api/alerting'

import { RoutingRulesPanel } from './RoutingRulesPanel'

vi.mock('@/api/alerting', () => ({
  alertingApi: { getMonitorsSummary: vi.fn() },
}))

function monitor(overrides: Record<string, unknown> = {}) {
  return {
    rule_id: 'rule-1',
    rule_name: 'Prod drops',
    destination_id: 'dest-1',
    destination_name: 'Ops Telegram',
    destination_type: 'telegram',
    status: 'healthy',
    enabled: true,
    muted: false,
    notify_on_spike: false,
    notify_on_drop: true,
    min_percent_delta: 50,
    cooldown_minutes: 60,
    last_anomaly_at: null,
    ...overrides,
  }
}

function renderPanel(monitors: ReturnType<typeof monitor>[], firing = 0) {
  vi.mocked(alertingApi.getMonitorsSummary).mockResolvedValue({
    monitors,
    total: monitors.length,
    firing_count: firing,
    warning_count: 0,
    healthy_count: monitors.length - firing,
  } as never)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RoutingRulesPanel slug="demo" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RoutingRulesPanel', () => {
  it('names the rules that are configured but not delivering', async () => {
    renderPanel(
      [
        monitor(),
        monitor({ rule_id: 'rule-2', muted: true }),
        monitor({ rule_id: 'rule-3', enabled: false }),
        monitor({ rule_id: 'rule-4', status: 'firing' }),
      ],
      1,
    )

    // `muted` and `off` both mean "wired up and silent", which is the failure
    // this tab exists to catch. The table this replaced never showed `muted` at
    // all — it had the field in hand and dropped it — so a snoozed rule read
    // as live on the page you visit to check your wiring.
    // Asserted as one whole line: the fragments are what the panel used to
    // stutter across two elements, and a loose matcher would not catch that
    // coming back.
    expect(
      await screen.findByText('4 rules routing · 1 firing · 1 muted · 1 off'),
    ).toBeInTheDocument()
  })

  it('states the summary once, not as a subtitle and a body line saying the same thing', async () => {
    renderPanel([monitor(), monitor({ rule_id: 'rule-2' })])

    // Subtitle "2 monitors · 0 firing" and body "2 monitors routing" were the
    // same sentence twice — the suffixes that would have differentiated them are
    // empty whenever nothing is firing, muted or off (tripl-oxkt.18).
    expect(await screen.findByText('2 rules routing')).toBeInTheDocument()
    expect(screen.queryByText(/2 monitors/)).toBeNull()
  })

  it('sends you to the surface that owns the mute rather than repeating it here', async () => {
    renderPanel([monitor()])

    const link = await screen.findByRole('link', { name: /Mute or tune a rule/ })
    expect(link).toHaveAttribute('href', '/p/demo/monitors')
    // The five columns it used to duplicate from MonitorsPage are gone.
    expect(screen.queryByRole('columnheader', { name: 'Condition' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Last fired' })).toBeNull()
  })

  it('says nothing routes yet instead of showing an empty count line', async () => {
    renderPanel([])

    expect(await screen.findByText('No rules route to a destination yet.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Mute or tune a rule/ })).toBeNull()
  })
})
