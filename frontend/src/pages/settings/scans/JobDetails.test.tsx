import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { ScanJob, ScanJobResultSummary } from '@/types'
import { JobDetails } from './JobDetails'
import type { ScanMode } from './scanMode'
import { RUN_VS_OPEN_SIGNALS_HINT } from './runReport'

/** Every counter the panel used to BE, in the order it renders them. */
const RAW_COUNTERS = [
  'Events created',
  'Variables created',
  'Events skipped',
  'Columns analyzed',
  'Event breakdowns',
  'Distribution rows',
  'Signals added',
  'Alerts queued',
]

/** A run that populates all eight, including the four optional ones. */
const FULL_SUMMARY: ScanJobResultSummary = {
  query_rows_scanned: 900,
  events_created: 12,
  events_skipped: 340,
  variables_created: 3,
  columns_analyzed: 17,
  breakdown_event_metrics: 5131,
  distribution_drifts: 4,
  signals_added: 1,
  alerts_queued: 1,
}

function job(summary: ScanJobResultSummary | null): ScanJob {
  return {
    id: 'job-1',
    scan_config_id: 'scan-1',
    status: 'completed',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:00:10Z',
    result_summary: summary,
    error_message: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:10Z',
  }
}

function renderDetails(summary: ScanJobResultSummary | null, mode: ScanMode = 'monitoring') {
  return render(
    <MemoryRouter>
      <JobDetails job={job(summary)} slug="demo" scanConfigId="scan-1" mode={mode} />
    </MemoryRouter>,
  )
}

describe('JobDetails', () => {
  it('leads with what the run did and demotes the eight raw counters behind a disclosure', () => {
    renderDetails(FULL_SUMMARY)

    // The sentences are there without clicking anything: this is the answer to
    // "did my events arrive, and which ones".
    expect(screen.getByText('What this run did')).toBeInTheDocument()
    expect(screen.getByText('Added 12 events to your tracking plan.')).toBeInTheDocument()
    expect(
      screen.getByText('340 events were already in your plan and were left as they are.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Recorded 5,131 metric points.')).toBeInTheDocument()

    // ...and not one of the eight internal counters is in the DOM yet.
    RAW_COUNTERS.forEach(label => {
      expect(
        screen.queryByText(label),
        `raw counter "${label}" is in the DOM before "Show raw counters" was clicked`,
      ).toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Show raw counters' }))

    // Nothing was lost — every counter is still reachable, under its own label.
    RAW_COUNTERS.forEach(label => {
      expect(
        screen.queryByText(label),
        `raw counter "${label}" went missing when the disclosure was opened`,
      ).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Hide raw counters' })).toBeInTheDocument()
    // The report does not go away when the counters come out.
    expect(screen.getByText('Added 12 events to your tracking plan.')).toBeInTheDocument()
  })

  it('states that the run\'s signal count is not the Anomalies page\'s open count', () => {
    // The activity feed says "1 new signal" for the run while the Anomalies page
    // shows a different number of open signals for the same scan. Both are
    // right; the screen never said so.
    renderDetails(FULL_SUMMARY)

    const signals = screen.getByText('Raised 1 anomaly signal.')
    expect(signals).toHaveAttribute('href', '/p/demo/anomalies?scan=scan-1')
    expect(signals).toHaveAttribute('title', 'View anomalies from this scan')
    expect(screen.getByText(RUN_VS_OPEN_SIGNALS_HINT)).toBeInTheDocument()

    const alerts = screen.getByText('Queued 1 alert.')
    expect(alerts).toHaveAttribute('href', '/p/demo/settings/alerting?scan=scan-1')
  })

  it('tells a catalog-only run why it produced no signals and no alerts', () => {
    renderDetails({ scan_rows_processed: 900, events_created: 12 }, 'catalog')

    expect(
      screen.getByText('Catalog-only scan — no metric points, so no signals and no alerts.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Recorded /)).toBeNull()
  })

  it('still shows the failure and the log for a run that has neither', () => {
    render(
      <MemoryRouter>
        <JobDetails
          job={{ ...job(null), status: 'failed', error_message: 'Read timed out.' }}
          slug="demo"
          scanConfigId="scan-1"
          mode="monitoring"
        />
      </MemoryRouter>,
    )

    expect(screen.getByText('Run details')).toBeInTheDocument()
    // No summary means no report and no disclosure — not an empty shell of both.
    expect(screen.queryByText('What this run did')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show raw counters' })).toBeNull()
  })
})
