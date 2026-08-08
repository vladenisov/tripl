import { describe, expect, it } from 'vitest'
import type { ScanJob, ScanJobResultSummary } from '@/types'
import {
  RUN_VS_OPEN_SIGNALS_HINT,
  buildRunReport,
  jobRowsKind,
  type RunReportLine,
} from './runReport'

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

function lineById(lines: RunReportLine[], id: string): RunReportLine | undefined {
  return lines.find(line => line.id === id)
}

describe('buildRunReport — "Rows read" covers two populations', () => {
  it('describes a catalog run and a metrics run of the same size differently', () => {
    // Same figure, two meanings: `scan_rows_processed` is what the catalog
    // analyzer read under the scan row cap, `query_rows_scanned` is what metrics
    // collection read across its chunks under the metrics row cap. One label has
    // always covered both.
    const catalogRows = lineById(buildRunReport(job({ scan_rows_processed: 900 }), 'catalog'), 'rows-read')!
    const metricsRows = lineById(buildRunReport(job({ query_rows_scanned: 900 }), 'monitoring'), 'rows-read')!

    expect(catalogRows.text).toBe('Read 900 warehouse rows.')
    expect(metricsRows.text).toBe('Read 900 warehouse rows.')

    // The sentence cannot vary, so the title has to. If these ever collapse to
    // one string — or to two undefineds — the user is back to one number that
    // silently means two things.
    expect(catalogRows.title).not.toEqual(metricsRows.title)
    expect(catalogRows.title).toContain('catalog analyzer')
    expect(catalogRows.title).toContain('capped by the row cap')
    expect(metricsRows.title).toContain('every metrics chunk')
    expect(metricsRows.title).toContain('capped by the metrics row cap')
  })

  it('labels the kind by the counter jobRowsScanned actually returns', () => {
    // jobRowsScanned prefers query_rows_scanned; the title must agree with it or
    // a metrics run would be described under the catalog cap.
    expect(jobRowsKind(job({ query_rows_scanned: 5, scan_rows_processed: 900 }))).toBe('metrics')
    expect(jobRowsKind(job({ scan_rows_processed: 900 }))).toBe('catalog')
    expect(jobRowsKind(job({}))).toBeNull()
    expect(jobRowsKind(job(null))).toBeNull()
  })

  it('names the chunks a replay read', () => {
    const lines = buildRunReport(
      job({
        mode: 'metrics_replay',
        query_rows_scanned: 900,
        replay_chunks_total: 4,
        replay_chunks_completed: 4,
      }),
      'monitoring',
    )
    expect(lineById(lines, 'rows-read')!.text).toBe('Read 900 warehouse rows across 4 chunks.')
  })
})

describe('buildRunReport — a catalog-only run', () => {
  it('says why it recorded nothing instead of leaving the user to infer it', () => {
    const lines = buildRunReport(job({ scan_rows_processed: 900, events_created: 3 }), 'catalog')

    expect(lines.map(line => line.text)).toContain(
      'Catalog-only scan — no metric points, so no signals and no alerts.',
    )
    // ...and it never claims points it cannot have collected.
    expect(lineById(lines, 'metric-points')).toBeUndefined()
    expect(lines.some(line => line.text.startsWith('Recorded'))).toBe(false)
  })

  it('says the same for a scan whose schedule is never dispatched', () => {
    // A schedule without a time column is never picked up, so its runs collect
    // exactly as much as a catalog-only scan's do: nothing.
    const lines = buildRunReport(job({ scan_rows_processed: 900 }), 'misconfigured')
    expect(lines.map(line => line.text)).toContain(
      'Catalog-only scan — no metric points, so no signals and no alerts.',
    )
  })

  it('never appears on a monitoring run that recorded points', () => {
    const lines = buildRunReport(
      job({ query_rows_scanned: 900, event_metrics: 2, type_metrics: 3, breakdown_event_metrics: 5, breakdown_type_metrics: 7 }),
      'monitoring',
    )
    expect(lineById(lines, 'metric-points')!.text).toBe('Recorded 17 metric points.')
    expect(lineById(lines, 'catalog-only')).toBeUndefined()
  })
})

describe('buildRunReport — the counters that read as bad news', () => {
  it('gives "skipped" a reason instead of a bare count', () => {
    // "Events skipped: 340" read as 340 lost events. It is the opposite.
    const nothingNew = buildRunReport(job({ events_created: 0, events_skipped: 340 }), 'monitoring')
    expect(lineById(nothingNew, 'events-none-new')!.text).toBe(
      'No new events — all 340 were already in your plan.',
    )

    const someNew = buildRunReport(job({ events_created: 2, events_skipped: 340 }), 'monitoring')
    expect(lineById(someNew, 'events-created')!.text).toBe('Added 2 events to your tracking plan.')
    expect(lineById(someNew, 'events-skipped')!.text).toBe(
      '340 events were already in your plan and were left as they are.',
    )
    // The two skipped sentences are alternatives, never both.
    expect(lineById(someNew, 'events-none-new')).toBeUndefined()
  })

  it('reads "columns analyzed" as coverage, not as a to-do', () => {
    const lines = buildRunReport(job({ columns_analyzed: 17 }), 'monitoring')
    expect(lineById(lines, 'columns-analyzed')!.text).toBe('Looked at 17 columns in your query.')
  })

  it('keeps its plurals honest for a run of one', () => {
    const lines = buildRunReport(
      job({ scan_rows_processed: 1, events_created: 1, events_skipped: 1, variables_created: 1, columns_analyzed: 1 }),
      'catalog',
    )
    expect(lines.map(line => line.text)).toEqual([
      'Read 1 warehouse row.',
      'Added 1 event to your tracking plan.',
      '1 event was already in your plan and was left as it is.',
      'Added 1 variable.',
      'Looked at 1 column in your query.',
      'Catalog-only scan — no metric points, so no signals and no alerts.',
    ])
  })
})

describe('buildRunReport — what this run raised vs what is open now', () => {
  it('says on screen that the two signal numbers answer different questions', () => {
    // The activity feed reports this run's delta; the Anomalies page reports the
    // project's open signals. Both are correct and they routinely disagree — a
    // fact that lived in a backend comment and in feature-reference.md, and on
    // no screen at all.
    const lines = buildRunReport(job({ signals_added: 1, alerts_queued: 2 }), 'monitoring')

    const signals = lineById(lines, 'signals-added')!
    expect(signals.text).toBe('Raised 1 anomaly signal.')
    expect(signals.hint).toBe(RUN_VS_OPEN_SIGNALS_HINT)
    expect(signals.hint).toMatch(/open now/)
    expect(signals.target).toBe('anomalies')

    const alerts = lineById(lines, 'alerts-queued')!
    expect(alerts.text).toBe('Queued 2 alerts.')
    expect(alerts.target).toBe('alerts')
  })

  it('omits both when the run raised nothing — a zero is not a sentence', () => {
    const lines = buildRunReport(job({ signals_added: 0, alerts_queued: 0 }), 'monitoring')
    expect(lineById(lines, 'signals-added')).toBeUndefined()
    expect(lineById(lines, 'alerts-queued')).toBeUndefined()
  })
})

describe('buildRunReport — nothing to report', () => {
  it('returns no lines for a run without a result summary', () => {
    expect(buildRunReport(job(null), 'monitoring')).toEqual([])
    expect(buildRunReport(null, 'monitoring')).toEqual([])
  })
})
