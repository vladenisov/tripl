import { type ReactNode, createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ScanConfig } from '@/types'
import {
  type ScanFormState,
  canSubmitScanForm,
  toBackendPayload,
  toDryRunRequest,
  useScanForm,
} from './useScanForm'

function formState(overrides: Partial<ScanFormState> = {}): ScanFormState {
  return {
    mode: 'monitoring',
    dataSourceId: 'ds-1',
    name: 'Main scan',
    baseQuery: 'SELECT * FROM analytics.events',
    eventTypeId: '',
    eventTypeColumn: '',
    timeColumn: 'received_at',
    appVersionColumn: '',
    appVersionPrereleasePattern: '',
    appVersionActiveShareMin: '',
    platformColumn: '',
    eventNameFormat: '',
    jsonValuePaths: [],
    eventGroupRules: [],
    metricBreakdownColumns: [],
    metricBreakdownValuesLimit: '',
    distributionDriftFields: [],
    cardinalityThreshold: 100,
    interval: '1h',
    chunkInterval: '1d',
    scanLookbackHours: '24',
    scanRowLimit: '',
    metricsRowLimit: '',
    ...overrides,
  }
}

describe('toBackendPayload', () => {
  // Catalog only is the absence of a SCHEDULE. Switching to it leaves the
  // previous schedule in state so switching back restores it, but it must not
  // reach the wire: a config saved with an interval and no time column is never
  // dispatched and collects nothing.
  it('drops the schedule in catalog mode, whatever the hidden inputs still hold', () => {
    const payload = toBackendPayload(formState({
      mode: 'catalog',
      interval: '1h',
      chunkInterval: '1d',
    }))

    expect(payload.interval).toBeNull()
    expect(payload.replay_chunk_interval).toBeNull()
  })

  // The defect: the mode radio used to null `time_column` too. Since the payload
  // is a full body and update_scan_config merges by exclude_unset, an explicit
  // null CLEARS the saved column — so editing a scan's name in Catalog only
  // silently removed the lookback bound and the next run read the whole table.
  // Nulling the interval alone already makes a config catalog-only.
  it('keeps the time column in catalog mode — catalog-only is no schedule, not no window', () => {
    const payload = toBackendPayload(formState({
      mode: 'catalog',
      timeColumn: 'event_ts',
      scanLookbackHours: '24',
    }))

    expect(payload.time_column).toBe('event_ts')
    expect(payload.scan_lookback_hours).toBe(24)
    expect(payload.interval).toBeNull()
  })

  it('sends null only when the user actually cleared the time column', () => {
    expect(toBackendPayload(formState({ mode: 'catalog', timeColumn: '' })).time_column).toBeNull()
  })

  it('sends both columns in monitoring mode', () => {
    const payload = toBackendPayload(formState())

    expect(payload.time_column).toBe('received_at')
    expect(payload.interval).toBe('1h')
    expect(payload.replay_chunk_interval).toBe('1d')
  })
})

describe('toDryRunRequest (tripl-3y7z.6)', () => {
  // "What would this scan create?" has to be answered for the config that would
  // actually be SAVED. Reading form state a second time is how the answer and
  // the saved scan drift apart, so the request is derived from the save payload
  // — including the window: a catalog scan with a time column is previewed over
  // the same lookback its runs will use, and one without a time column is
  // previewed over everything, exactly as its runs will read.
  it('asks about the config that would be saved, over the window that config would read', () => {
    const request = toDryRunRequest(formState({
      mode: 'catalog',
      timeColumn: 'received_at',
      interval: '1h',
    }))

    expect(request.time_column).toBe('received_at')
    expect(request.data_source_id).toBe('ds-1')
    expect(request.base_query).toBe('SELECT * FROM analytics.events')
  })

  it('reports an unbounded read as unbounded when there is no time column', () => {
    const request = toDryRunRequest(formState({ mode: 'catalog', timeColumn: '' }))

    expect(request.time_column).toBeNull()
  })

  it('carries the naming inputs the planner reads, so the names it reports are the names a run writes', () => {
    const request = toDryRunRequest(formState({
      eventTypeColumn: 'event_name',
      eventNameFormat: '{action}:{category}',
      cardinalityThreshold: 25,
      scanLookbackHours: '48',
    }))

    expect(request.event_type_column).toBe('event_name')
    expect(request.event_name_format).toBe('{action}:{category}')
    expect(request.cardinality_threshold).toBe(25)
    expect(request.scan_lookback_hours).toBe(48)
    expect(request.time_column).toBe('received_at')
  })
})

describe('useScanForm — editing a saved catalog scan (tripl-3y7z)', () => {
  function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return createElement(QueryClientProvider, { client }, children)
  }

  // The whole defect, end to end: a saved manual scan bounded to the last 24h
  // (time column, no interval) is classified `catalog`, so its edit form opens on
  // "Catalog only". Opening the Configuration tab, changing the name and pressing
  // Save must not clear the column that bounds every run — a full payload with an
  // explicit "time_column": null is a DELETE, not an omission.
  it('preserves the saved time column through an unrelated edit', () => {
    const saved = {
      id: 'sc-1',
      data_source_id: 'ds-1',
      name: 'Nightly catalog',
      base_query: 'SELECT * FROM analytics.events',
      time_column: 'event_ts',
      interval: null,
      scan_lookback_hours: 24,
      cardinality_threshold: 100,
    } as unknown as ScanConfig

    const { result } = renderHook(() => useScanForm('demo', saved), { wrapper })

    // The form opened where formModeOf put it — Catalog only, because there is
    // no schedule.
    expect(result.current.state.mode).toBe('catalog')

    const payload = result.current.toBackendPayload()
    expect(payload.time_column).toBe('event_ts')
    expect(payload.scan_lookback_hours).toBe(24)
    // Still catalog-only: no schedule is what makes it one.
    expect(payload.interval).toBeNull()
  })
})

describe('canSubmitScanForm', () => {
  it('refuses a monitoring scan with no time column — it would report success and monitor nothing', () => {
    expect(canSubmitScanForm(formState({ timeColumn: '' }))).toBe(false)
  })

  it('refuses a monitoring scan with no schedule', () => {
    expect(canSubmitScanForm(formState({ interval: '' }))).toBe(false)
  })

  it('accepts a catalog-only scan with both empty: there, empty is the answer', () => {
    expect(canSubmitScanForm(formState({ mode: 'catalog', timeColumn: '', interval: '' }))).toBe(true)
  })

  it('still requires a source, a name and a query in either mode', () => {
    expect(canSubmitScanForm(formState({ mode: 'catalog', name: '   ' }))).toBe(false)
    expect(canSubmitScanForm(formState({ mode: 'catalog', dataSourceId: '' }))).toBe(false)
    expect(canSubmitScanForm(formState({ mode: 'catalog', baseQuery: '' }))).toBe(false)
  })
})
