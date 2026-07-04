import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DataSource, ScanConfig } from '@/types'
import { ScanListRow } from './ScanConfigRow'
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
