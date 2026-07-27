import { describe, expect, it } from 'vitest'
import type { ScanJob } from '@/types'
import { STATUS_META } from './scanLayoutConstants'
import {
  LOADING_SCAN_RUN_INFO,
  consecutiveFailedRuns,
  deriveScanRunInfo,
  eligibleChunkIntervals,
  jobDurationSeconds,
  jobRowsScanned,
  summarizeScanChanges,
} from './scanUtils'

function job(overrides: Partial<ScanJob>): ScanJob {
  return {
    id: 'job',
    scan_config_id: 'scan',
    status: 'completed',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:00:10Z',
    result_summary: null,
    error_message: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:10Z',
    ...overrides,
  }
}

describe('summarizeScanChanges', () => {
  it('is empty for a job with no result summary', () => {
    expect(summarizeScanChanges(job({ result_summary: null }))).toEqual([])
    expect(summarizeScanChanges(null)).toEqual([])
  })

  it('surfaces only the non-zero deltas of a completed run', () => {
    const changes = summarizeScanChanges(
      job({
        result_summary: {
          events_created: 12,
          event_metrics: 3,
          breakdown_event_metrics: 2,
          signals_added: 1,
          alerts_queued: 0,
        },
      }),
    )
    const labels = changes.map((change) => change.label)
    expect(labels).toContain('+12 events')
    // Time-series rows collected — NOT metric definitions created (tripl-2gtk).
    expect(labels).toContain('+5 metric points')
    expect(labels).toContain('+1 signal')
    // A zero delta is omitted, not shown as "+0".
    expect(labels.some((label) => label.includes('alert'))).toBe(false)
  })
})

describe('deriveScanRunInfo', () => {
  it('returns idle when there are no jobs', () => {
    expect(deriveScanRunInfo([])).toMatchObject({ status: 'idle', lastRunLabel: 'never' })
  })

  // "Never run" is a verdict. Coercing an unresolved job query to `[]` made
  // every row claim it had never run while the activity rail on the same screen
  // listed completed runs (tripl-jfm3.28).
  it('reports unknown — not idle — while the job query is still loading', () => {
    expect(deriveScanRunInfo(undefined)).toEqual(LOADING_SCAN_RUN_INFO)
    expect(deriveScanRunInfo(undefined).status).toBe('unknown')
    expect(deriveScanRunInfo(undefined).lastRunLabel).not.toBe('never')
    expect(STATUS_META[deriveScanRunInfo(undefined).status].label).not.toBe('Never run')
  })

  it('reports running for an in-flight latest job', () => {
    expect(deriveScanRunInfo([job({ status: 'running' })])).toMatchObject({
      status: 'running',
      lastRunLabel: 'running',
    })
  })

  it('reports failed when the latest job failed', () => {
    expect(deriveScanRunInfo([job({ status: 'failed' })]).status).toBe('failed')
  })

  it('reports ok for a completed latest job', () => {
    expect(deriveScanRunInfo([job({ status: 'completed' })]).status).toBe('ok')
  })
})

describe('jobRowsScanned', () => {
  it('prefers query_rows_scanned then scan_rows_processed', () => {
    expect(jobRowsScanned(job({ result_summary: { query_rows_scanned: 42 } }))).toBe(42)
    expect(jobRowsScanned(job({ result_summary: { scan_rows_processed: 7 } }))).toBe(7)
    expect(jobRowsScanned(job({ result_summary: {} }))).toBeNull()
    expect(jobRowsScanned(null)).toBeNull()
  })
})

describe('jobDurationSeconds', () => {
  it('computes seconds between start and completion', () => {
    expect(jobDurationSeconds(job({}))).toBe(10)
  })

  it('returns null when not finished', () => {
    expect(jobDurationSeconds(job({ completed_at: null }))).toBeNull()
  })
})

describe('consecutiveFailedRuns', () => {
  it('returns 0 when there are no jobs', () => {
    expect(consecutiveFailedRuns([])).toBe(0)
  })

  it('counts leading failed runs (newest-first) and stops at the first success', () => {
    expect(
      consecutiveFailedRuns([
        job({ status: 'failed' }),
        job({ status: 'failed' }),
        job({ status: 'failed' }),
        job({ status: 'completed' }),
        job({ status: 'failed' }),
      ]),
    ).toBe(3)
  })

  it('skips an in-flight retry at the head so the streak is not reset', () => {
    expect(
      consecutiveFailedRuns([
        job({ status: 'running' }),
        job({ status: 'failed' }),
        job({ status: 'failed' }),
      ]),
    ).toBe(2)
  })

  it('returns 0 when the latest settled run succeeded', () => {
    expect(consecutiveFailedRuns([job({ status: 'completed' }), job({ status: 'failed' })])).toBe(0)
  })

  it('stops the streak at a cancelled run', () => {
    expect(
      consecutiveFailedRuns([
        job({ status: 'failed' }),
        job({ status: 'cancelled' }),
        job({ status: 'failed' }),
      ]),
    ).toBe(1)
  })
})

describe('eligibleChunkIntervals', () => {
  it('returns the interval and coarser sizes', () => {
    expect(eligibleChunkIntervals('1h')).toEqual(['1h', '6h', '1d', '1w'])
    expect(eligibleChunkIntervals('')).toEqual([])
  })
})
