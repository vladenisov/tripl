import { describe, expect, it } from 'vitest'
import {
  type ScanFormState,
  canSubmitScanForm,
  effectiveTimeColumn,
  toBackendPayload,
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
  // Switching to Catalog only leaves the previous picks in state so switching
  // back restores them. They must not reach the wire: a config saved with an
  // interval and no time column is never dispatched and collects nothing.
  it('forces the three monitoring columns to null in catalog mode, whatever the hidden inputs still hold', () => {
    const payload = toBackendPayload(formState({
      mode: 'catalog',
      timeColumn: 'received_at',
      interval: '1h',
      chunkInterval: '1d',
    }))

    expect(payload.time_column).toBeNull()
    expect(payload.interval).toBeNull()
    expect(payload.replay_chunk_interval).toBeNull()
  })

  it('sends both columns in monitoring mode', () => {
    const payload = toBackendPayload(formState())

    expect(payload.time_column).toBe('received_at')
    expect(payload.interval).toBe('1h')
    expect(payload.replay_chunk_interval).toBe('1d')
  })

  it('keeps the preview windowed by the same time column the payload carries', () => {
    expect(effectiveTimeColumn(formState())).toBe('received_at')
    expect(effectiveTimeColumn(formState({ mode: 'catalog' }))).toBeNull()
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
