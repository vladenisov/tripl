import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DataSource, ScanConfig } from '@/types'
import { ScanBadges, ScanListRow } from './ScanConfigRow'
import type { ScanRunInfo } from './scanUtils'

const sc = { id: 'sc-1', name: 'Orders scan', base_query: 'select 1' } as unknown as ScanConfig
const runInfo = { status: 'idle', lastRunLabel: '', lastJob: null } as unknown as ScanRunInfo

function renderRow(overrides: Partial<Parameters<typeof ScanListRow>[0]> = {}) {
  const onNavigate = vi.fn()
  const onReviewEvents = vi.fn()
  render(
    <table>
      <tbody>
        <ScanListRow
          sc={sc}
          dataSource={null as DataSource | null}
          runInfo={runInfo}
          intervalLabel={{}}
          onNavigate={onNavigate}
          onReviewEvents={onReviewEvents}
          {...overrides}
        />
      </tbody>
    </table>,
  )
  return { onNavigate, onReviewEvents }
}

describe('ScanListRow review-events action (tripl-7l83.11.3)', () => {
  it('triggers review navigation without opening the scan detail', () => {
    const { onNavigate, onReviewEvents } = renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'Review events from Orders scan' }))
    expect(onReviewEvents).toHaveBeenCalledTimes(1)
    // stopPropagation keeps the row's own navigate from firing.
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('omits the action when no handler is provided', () => {
    renderRow({ onReviewEvents: undefined })
    expect(screen.queryByRole('button', { name: /Review events/ })).toBeNull()
  })
})

describe('ScanListRow run action (tripl-q7i1.5)', () => {
  it('omits Run now when no onRun handler is provided', () => {
    renderRow()
    expect(screen.queryByRole('button', { name: /Run Orders scan now/ })).toBeNull()
  })

  it('runs without opening the scan detail (stops propagation)', () => {
    const onRun = vi.fn()
    const { onNavigate } = renderRow({ onRun })
    fireEvent.click(screen.getByRole('button', { name: 'Run Orders scan now' }))
    expect(onRun).toHaveBeenCalledTimes(1)
    // stopPropagation keeps the row's own navigate from firing.
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('disables Run now while a run is pending', () => {
    renderRow({ onRun: vi.fn(), runPending: true })
    expect(screen.getByRole('button', { name: 'Run Orders scan now' })).toBeDisabled()
  })
})

// Every value below survives a switch to Catalog only on purpose (useScanForm
// mode-gates the schedule and nothing else), so a catalog scan really can carry
// all three — which is exactly why the strip has to stop announcing them.
function badgeConfig(overrides: Partial<ScanConfig> = {}): ScanConfig {
  return {
    id: 'sc-1',
    name: 'Orders scan',
    base_query: 'select 1',
    time_column: 'event_ts',
    interval: '1h',
    scan_lookback_hours: 24,
    scan_row_limit: 1000,
    metrics_row_limit: 50000,
    json_value_paths: [],
    metric_breakdown_columns: ['platform', 'country'],
    distribution_drift_fields: ['plan'],
    app_version_column: null,
    event_group_rules: [],
    ...overrides,
  } as unknown as ScanConfig
}

describe('ScanBadges — metrics bounds belong to the mode that applies them (tripl-3y7z)', () => {
  it('announces the three metrics bounds on a monitoring scan, which is the scan that has them', () => {
    render(<ScanBadges sc={badgeConfig()} intervalLabel={{ '1h': 'Hourly' }} />)

    expect(screen.getByText('Monitoring')).toBeInTheDocument()
    expect(screen.getByText('Metrics cap 50,000')).toBeInTheDocument()
    expect(screen.getByText('Breakdowns 2')).toBeInTheDocument()
    expect(screen.getByText('Distribution 1')).toBeInTheDocument()
  })

  // The header read `Catalog only · Metrics cap 50,000 · Breakdowns 2 ·
  // Distribution 1` one line under the causal note that says this scan records no
  // metric points. All three bounds are read by `collect_metrics` alone, and the
  // scheduler never dispatches a config with no interval, so all three described
  // a run that does not exist.
  it('drops them on a Catalog only scan, which never runs the task that reads them', () => {
    render(
      <ScanBadges sc={badgeConfig({ interval: null })} intervalLabel={{}} />,
    )

    expect(screen.getByText('Catalog only')).toBeInTheDocument()
    expect(screen.queryByText(/Metrics cap/)).toBeNull()
    expect(screen.queryByText(/Breakdowns/)).toBeNull()
    expect(screen.queryByText(/Distribution/)).toBeNull()
    // The bounds a catalog run really does apply stay: this is a gate on three
    // badges, not a blank strip.
    expect(screen.getByText('Scan cap 1,000')).toBeInTheDocument()
    expect(screen.getByText('Lookback 24h')).toBeInTheDocument()
  })

  // `Needs a time column` is not catalog-only, but the dispatcher skips it for the
  // same reason, so the metrics bounds are just as inapplicable there.
  it('drops them on a scan whose schedule never fires for want of a time column', () => {
    render(
      <ScanBadges sc={badgeConfig({ time_column: null })} intervalLabel={{ '1h': 'Hourly' }} />,
    )

    expect(screen.getByText('Needs a time column')).toBeInTheDocument()
    expect(screen.queryByText(/Metrics cap/)).toBeNull()
    expect(screen.queryByText(/Breakdowns/)).toBeNull()
    expect(screen.queryByText(/Distribution/)).toBeNull()
  })
})
