import { describe, expect, it } from 'vitest'
import { SCAN_MODE_BADGE, SCAN_MODE_DETAIL_LABEL, formModeOf, scanModeOf } from './scanMode'
import type { ScanConfig } from '@/types'

function config(overrides: Partial<ScanConfig>): ScanConfig {
  return {
    id: 'scan-1',
    data_source_id: 'ds-1',
    project_id: 'p-1',
    event_type_id: null,
    name: 'Scan',
    base_query: 'SELECT 1',
    event_type_column: null,
    time_column: null,
    event_name_format: null,
    json_value_paths: [],
    event_group_rules: [],
    metric_breakdown_columns: [],
    metric_breakdown_values_limit: null,
    distribution_drift_fields: [],
    app_version_column: null,
    app_version_prerelease_pattern: null,
    app_version_active_share_min: null,
    platform_column: null,
    cardinality_threshold: 100,
    interval: null,
    replay_chunk_interval: null,
    scan_lookback_hours: null,
    scan_row_limit: null,
    metrics_row_limit: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as ScanConfig
}

describe('scanModeOf — the four quadrants of (time_column, interval)', () => {
  it('is monitoring when both are set: the dispatcher selects exactly this shape', () => {
    expect(scanModeOf(config({ time_column: 'ts', interval: '1h' }))).toBe('monitoring')
  })

  it('is catalog when both are empty: a deliberate answer, not a fault', () => {
    expect(scanModeOf(config({ time_column: null, interval: null }))).toBe('catalog')
  })

  // The state this whole change exists to name. Collapsing the derivation to two
  // states renders it as "Catalog only" and launders the CLI's
  // scan_config_not_dispatchable FAIL into a feature.
  it('is misconfigured with an interval but no time column — never dispatched, never a catalog scan either', () => {
    expect(scanModeOf(config({ time_column: null, interval: '1h' }))).toBe('misconfigured')
  })

  it('is catalog with a time column but no schedule: a bounded catalog window is legitimate', () => {
    expect(scanModeOf(config({ time_column: 'ts', interval: null }))).toBe('catalog')
  })
})

describe('formModeOf', () => {
  it('defaults a new scan to monitoring', () => {
    expect(formModeOf(null)).toBe('monitoring')
  })

  it('opens a catalog-only config on catalog', () => {
    expect(formModeOf(config({ time_column: null, interval: null }))).toBe('catalog')
  })

  // Opening a misconfigured config on "monitoring" is what makes saving the form
  // fix it: the empty Time column is asked for instead of silently discarded.
  it('opens a misconfigured config on monitoring so the missing time column is asked for', () => {
    expect(formModeOf(config({ time_column: null, interval: '1h' }))).toBe('monitoring')
  })
})

describe('mode copy', () => {
  it('warns only on the misconfigured quadrant', () => {
    expect(SCAN_MODE_BADGE.misconfigured.label).toBe('No metrics collected')
    expect(SCAN_MODE_BADGE.misconfigured.tone).toBe('warning')
    expect(SCAN_MODE_BADGE.catalog.tone).not.toBe('warning')
    expect(SCAN_MODE_BADGE.monitoring.tone).not.toBe('warning')
  })

  it('spells out on the detail page why a scheduled scan is still catalog-only', () => {
    expect(SCAN_MODE_DETAIL_LABEL.misconfigured).toBe(
      'Catalog only — schedule set but no time column',
    )
  })
})
