// Metrics catalog types, sourced directly from the committed backend OpenAPI
// (`api.gen.ts`) so the frontend stays in lock-step with the backend schemas.
// The catalog metric kinds (`sql` / `fact` / `event_composition`)
// form a discriminated union on `kind`; the create payloads mirror that union.
import type { components } from './api.gen'

type Schemas = components['schemas']

// ───────── Enums ─────────
export type MetricKind = Schemas['MetricKind']
export type MetricStatus = Schemas['MetricStatus']
export type MetricAggregation = Schemas['MetricAggregation']
export type MetricComposition = Schemas['MetricComposition']
export type MetricScanInterval = Schemas['ScanInterval']

// ───────── Kind-specific config blocks ─────────
export type SqlConfig = Schemas['SqlConfig']

// ───────── Create payloads (discriminated on `kind`) ─────────
export type FactMetricCreate = Schemas['FactMetricCreate']
export type SqlMetricCreate = Schemas['SqlMetricCreate']
export type EventCompositionMetricCreate = Schemas['EventCompositionMetricCreate']
export type MetricCreate =
  | FactMetricCreate
  | SqlMetricCreate
  | EventCompositionMetricCreate

// ───────── Update / bulk / reorder / move ─────────
export type MetricDefinitionUpdate = Schemas['MetricDefinitionUpdate']
export type MetricDefinitionBulkUpdate = Schemas['MetricDefinitionBulkUpdate']
export type MetricDefinitionReorder = Schemas['MetricDefinitionReorder']
export type MetricDefinitionMove = Schemas['MetricDefinitionMove']

// ───────── Read shapes ─────────
export type MetricDefinitionListItem = Schemas['MetricDefinitionListItem']
export type MetricDefinitionListResponse = Schemas['MetricDefinitionListResponse']
export type MetricDefinitionResponse = Schemas['MetricDefinitionResponse']

// ───────── Series / breakdown / version shapes ─────────
export type MetricSeriesPoint = Schemas['MetricSeriesPoint']
export type MetricSeriesResponse = Schemas['MetricSeriesResponse']
export type MetricSignalResponse = Schemas['MetricSignalResponse']
export type MetricBreakdownSeries = Schemas['MetricBreakdownSeries']
export type MetricBreakdownsResponse = Schemas['MetricBreakdownsResponse']
export type MetricVersionSeries = Schemas['MetricVersionSeries']
export type MetricVersionSeriesResponse = Schemas['MetricVersionSeriesResponse']

// ───────── UI option lists ─────────
export const METRIC_KINDS: readonly MetricKind[] = [
  'fact',
  'sql',
  'event_composition',
]

export const METRIC_STATUSES: readonly MetricStatus[] = ['draft', 'active', 'archived']

export const METRIC_AGGREGATIONS: readonly MetricAggregation[] = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'count_distinct',
]

export const METRIC_COMPOSITIONS: readonly MetricComposition[] = [
  'single',
  'ratio',
  'per_distinct_user',
]

export const METRIC_SCAN_INTERVALS: readonly MetricScanInterval[] = [
  '15m',
  '1h',
  '6h',
  '1d',
  '1w',
]

export const METRIC_KIND_LABEL: Record<MetricKind, string> = {
  fact: 'Fact',
  sql: 'SQL',
  event_composition: 'Event composition',
}

export const METRIC_STATUS_LABEL: Record<MetricStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
}
