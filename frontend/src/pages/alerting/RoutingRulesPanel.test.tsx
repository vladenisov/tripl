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
  it('names the monitors that are configured but not delivering', async () => {
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
    // all — it had the field in hand and dropped it — so a snoozed monitor read
    // as live on the page you visit to check your wiring.
    // Asserted as one line rather than four fragments: "1 firing" also appears
    // in the panel subtitle, so a loose matcher would pass on the wrong element.
    expect(
      await screen.findByText('4 monitors routing · 1 firing · 1 muted · 1 off'),
    ).toBeInTheDocument()
  })

  it('sends you to the monitors list rather than repeating it', async () => {
    renderPanel([monitor()])

    const link = await screen.findByRole('link', { name: /View monitors/ })
    expect(link).toHaveAttribute('href', '/p/demo/monitors')
    // The five columns it used to duplicate from MonitorsPage are gone.
    expect(screen.queryByRole('columnheader', { name: 'Condition' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Last fired' })).toBeNull()
  })

  it('says nothing routes yet instead of showing an empty count line', async () => {
    renderPanel([])

    expect(await screen.findByText('No monitors route to a destination yet.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /View monitors/ })).toBeNull()
  })
})
