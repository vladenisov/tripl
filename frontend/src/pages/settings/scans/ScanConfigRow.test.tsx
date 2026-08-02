import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { DataSource, ScanConfig } from '@/types'
import { ScanListRow } from './ScanConfigRow'
import type { ScanRunInfo } from './scanUtils'

const sc = { id: 'sc-1', name: 'Orders scan', base_query: 'select 1' } as unknown as ScanConfig
const runInfo = { status: 'idle', lastRunLabel: '', lastJob: null } as unknown as ScanRunInfo
const DETAIL_HREF = '/p/demo/settings/scans/sc-1'

// MemoryRouter is required since the scan name became a <Link> — the row's one
// focusable primary action, which replaced the old role="button" row.
function renderRow(overrides: Partial<Parameters<typeof ScanListRow>[0]> = {}) {
  const onNavigate = vi.fn()
  const onReviewEvents = vi.fn()
  render(
    <MemoryRouter>
      <table>
        <tbody>
          <ScanListRow
            sc={sc}
            dataSource={null as DataSource | null}
            runInfo={runInfo}
            intervalLabel={{}}
            detailHref={DETAIL_HREF}
            onNavigate={onNavigate}
            onReviewEvents={onReviewEvents}
            {...overrides}
          />
        </tbody>
      </table>
    </MemoryRouter>,
  )
  return { onNavigate, onReviewEvents }
}

describe('ScanListRow keyboard reachability', () => {
  it('exposes the scan name as a link to the detail route', () => {
    renderRow()
    expect(screen.getByRole('link', { name: 'Orders scan' })).toHaveAttribute('href', DETAIL_HREF)
  })

  it('does not wrap the row in a widget role around its own controls', () => {
    renderRow({ onRun: vi.fn() })
    // A role="button" row owning Run/Review buttons is axe's nested-interactive.
    expect(screen.queryByRole('button', { name: /View scan config/ })).toBeNull()
  })
})

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
