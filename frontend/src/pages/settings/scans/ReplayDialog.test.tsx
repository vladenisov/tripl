import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IntervalCode, ScanConfig } from '@/types'

import { ReplayDialog } from './ReplayDialog'

vi.mock('@/api/scans', () => ({
  scansApi: { replayMetrics: vi.fn(async () => ({})) },
}))

/** A Saturday afternoon, mid-bucket on every interval the backend supports. */
const NOW = new Date('2026-09-12T14:37:00Z')

function renderDialog(interval: IntervalCode | null) {
  const scanConfig = { id: 'scan-1', interval } as unknown as ScanConfig
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReplayDialog slug="demo" scanConfig={scanConfig} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  )
}

/**
 * The instant a `datetime-local` input holds. The component formats in local
 * time and `new Date('YYYY-MM-DDTHH:mm')` parses in local time, so this round
 * trip is exact and the assertions below hold in any timezone the suite runs in.
 */
function instantOf(label: string): number {
  const input = screen.getByLabelText(label) as HTMLInputElement
  expect(input.value).not.toBe('')
  return new Date(input.value).getTime()
}

describe('ReplayDialog — the seeded period must be one the backend accepts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  // The defect: the period was seeded to the current LOCAL hour regardless of the
  // scan's interval, which reaches into the interval still filling on every
  // config coarser than an hour. Replay refuses that period — it holds no
  // complete bucket — so opening this dialog on a daily or weekly scan and
  // pressing Replay produced a job that could only fail (tripl-0zpq.22).
  it.each([
    ['1d' as const, Date.UTC(2026, 8, 12), 24 * 60 * 60 * 1000],
    // 1w bins from Monday, like every warehouse adapter: the Monday before this
    // Saturday, not the Saturday itself.
    ['1w' as const, Date.UTC(2026, 8, 7), 7 * 24 * 60 * 60 * 1000],
    ['6h' as const, Date.UTC(2026, 8, 12, 12), 24 * 60 * 60 * 1000],
    ['1h' as const, Date.UTC(2026, 8, 12, 14), 24 * 60 * 60 * 1000],
    ['15m' as const, Date.UTC(2026, 8, 12, 14, 30), 24 * 60 * 60 * 1000],
  ])('ends on the last complete %s bucket', (interval, expectedTo, expectedSpan) => {
    renderDialog(interval)

    expect(instantOf('To')).toBe(expectedTo)
    expect(instantOf('To') - instantOf('From')).toBe(expectedSpan)
    // Never inside the interval that is still filling.
    expect(instantOf('To')).toBeLessThanOrEqual(NOW.getTime())
  })

  it('falls back to the hourly grid when the scan has no interval yet', () => {
    // A catalog-only scan cannot replay at all, but the dialog still mounts with
    // the danger zone, and a null interval must not index an empty grid.
    renderDialog(null)

    expect(instantOf('To')).toBe(Date.UTC(2026, 8, 12, 14))
  })
})
