/**
 * The metric editor's form state as one plain object, plus the pure helpers
 * around it: hydrate it from a stored definition, validate it, and derive the
 * internal name. Kept out of the component so every rule here is unit-tested
 * without rendering a form (MET-42).
 */

import {
  METRIC_AGGREGATIONS,
  type MetricAggregation,
  type MetricComposition,
  type MetricDefinitionDetailResponse,
  type MetricKind,
  type MetricScanInterval,
  type MetricStatus,
  DEFAULT_ENTITY_COLOR,
} from '@/types'
import { readFactOperandConfig, type FactOperandConfig } from '@/lib/factOperandConfig'
import { filterRowErrors, filtersFromConfig, type FactFilter } from './factFilters'

export const DEFAULT_METRIC_COLOR = DEFAULT_ENTITY_COLOR

export const FACT_COMPOSITIONS = ['single', 'ratio'] as const
export type FactComposition = (typeof FACT_COMPOSITIONS)[number]

/**
 * One side of a fact metric (the single operand, or the numerator /
 * denominator of a ratio), held flat and mapped to the payload at submit time.
 */
export interface FactOperandState {
  factTableId: string
  aggregation: MetricAggregation
  measureColumn: string
  distinctColumn: string
  // An ordered list of named/SQL/condition filters, all combined with AND.
  filters: FactFilter[]
}

export const EMPTY_OPERAND: FactOperandState = {
  factTableId: '',
  aggregation: 'count',
  measureColumn: '',
  distinctColumn: '',
  filters: [],
}

/** Every input the author can change on the metric editor. */
export interface MetricDraft {
  kind: MetricKind
  displayName: string
  name: string
  description: string
  status: MetricStatus
  unit: string
  color: string
  anomalyDetection: boolean
  breakdownColumns: string[]
  appVersionColumn: string
  platformColumn: string
  // Collection settings shared by SQL and fact metrics.
  dataSourceId: string
  interval: MetricScanInterval
  /**
   * Set through the API or the demo, never through this form, and re-sent as
   * stored. Null while the interval is coarser than it, and back once the
   * interval is not — the backend refuses a chunk finer than the interval, and
   * the user could not see the field the 422 named (MET-10).
   */
  replayChunkInterval: MetricScanInterval | null
  // SQL
  metricSql: string
  sqlTimeColumn: string
  sqlValueColumn: string
  // Event composition
  composition: MetricComposition
  userIdColumn: string
  numeratorEventId: string
  denominatorEventId: string
  numeratorEventTypeId: string
  denominatorEventTypeId: string
  // Fact. The single operand reuses `numeratorOp`; ratio adds `denominatorOp`.
  factComposition: FactComposition
  numeratorOp: FactOperandState
  denominatorOp: FactOperandState
}

export function needsMeasure(aggregation: MetricAggregation): boolean {
  return (
    aggregation === 'sum'
    || aggregation === 'avg'
    || aggregation === 'min'
    || aggregation === 'max'
  )
}

export function needsDistinct(aggregation: MetricAggregation): boolean {
  return aggregation === 'count_distinct'
}

export function operandFromConfig(config: FactOperandConfig): FactOperandState {
  return {
    factTableId: config.factTableId ?? '',
    aggregation: config.aggregation,
    measureColumn: config.measureColumn ?? '',
    distinctColumn: config.distinctColumn ?? '',
    filters: filtersFromConfig(config),
  }
}

/** Breakdown and dimension columns as saved for `kind`, or empty for another kind. */
export function savedDimensions(
  metric: MetricDefinitionDetailResponse | null,
  kind: MetricKind,
): Pick<MetricDraft, 'breakdownColumns' | 'appVersionColumn' | 'platformColumn'> {
  if (!metric || metric.kind !== kind) {
    return { breakdownColumns: [], appVersionColumn: '', platformColumn: '' }
  }
  return {
    breakdownColumns: metric.breakdown_columns ?? [],
    appVersionColumn: metric.app_version_column ?? '',
    platformColumn: metric.platform_column ?? '',
  }
}

export function draftFromMetric(metric: MetricDefinitionDetailResponse | null): MetricDraft {
  const config = (metric?.config ?? {}) as Record<string, unknown>
  const configString = (key: string): string => {
    const value = config[key]
    return typeof value === 'string' ? value : ''
  }
  const isFactRatio = metric?.kind === 'fact' && metric.composition === 'ratio'
  const singleOperand = operandFromConfig(
    readFactOperandConfig(config, {
      factTableId: metric?.fact_table_id ?? null,
      aggregation:
        metric?.aggregation && METRIC_AGGREGATIONS.includes(metric.aggregation)
          ? metric.aggregation
          : 'count',
    }),
  )
  const ratioNumerator = operandFromConfig(readFactOperandConfig(config['numerator']))
  return {
    kind: metric?.kind ?? 'sql',
    displayName: metric?.display_name ?? '',
    name: metric?.name ?? '',
    description: metric?.description ?? '',
    status: metric?.status ?? 'draft',
    unit: metric?.unit ?? '',
    color: metric?.color ?? DEFAULT_METRIC_COLOR,
    anomalyDetection: metric?.anomaly_detection_enabled ?? true,
    ...savedDimensions(metric, metric?.kind ?? 'sql'),
    dataSourceId: metric?.data_source_id ?? '',
    interval: metric?.interval ?? '1h',
    replayChunkInterval: metric?.replay_chunk_interval ?? null,
    metricSql: configString('metric_sql'),
    sqlTimeColumn: configString('time_column'),
    sqlValueColumn: configString('value_column'),
    composition: metric?.composition ?? 'single',
    userIdColumn: configString('user_id_column'),
    numeratorEventId: metric?.numerator_event_id ?? '',
    denominatorEventId: metric?.denominator_event_id ?? '',
    numeratorEventTypeId: metric?.numerator_event_type_id ?? '',
    denominatorEventTypeId: metric?.denominator_event_type_id ?? '',
    factComposition: isFactRatio ? 'ratio' : 'single',
    numeratorOp: isFactRatio && ratioNumerator.factTableId ? ratioNumerator : singleOperand,
    denominatorOp: operandFromConfig(readFactOperandConfig(config['denominator'])),
  }
}

/** DOM id of one filter row's first control, used as its validation key. */
export function filterFieldId(idPrefix: string, filterId: string): string {
  return `${idPrefix}-filter-${filterId}`
}

/**
 * Validate one operand against the backend required-field rules. `label` names
 * the side for ratio operands ('numerator' / 'denominator'); empty for a single
 * operand. Keys are the DOM ids of the offending inputs (`${idPrefix}-table`,
 * a filter row's {@link filterFieldId}) so the caller can render inline errors
 * and move focus to the first one.
 */
export function operandErrors(
  operand: FactOperandState,
  idPrefix: string,
  label: string,
): Record<string, string> {
  const errs: Record<string, string> = {}
  const qualifier = label ? `${label} ` : ''
  if (!operand.factTableId) {
    errs[`${idPrefix}-table`] = label
      ? `A ${label} fact table is required.`
      : 'A fact table is required for a fact metric.'
  }
  if (needsMeasure(operand.aggregation) && !operand.measureColumn) {
    errs[`${idPrefix}-measure`] = `A ${qualifier}measure column is required for the ${operand.aggregation} aggregation.`
  }
  if (needsDistinct(operand.aggregation) && !operand.distinctColumn) {
    errs[`${idPrefix}-distinct`] = `A ${qualifier}distinct column is required for the count_distinct aggregation.`
  }
  const rowErrors = filterRowErrors(operand.filters)
  operand.filters.forEach((filter, index) => {
    const message = rowErrors[filter.id]
    if (!message) return
    const side = label ? `${label.charAt(0).toUpperCase()}${label.slice(1)} filter` : 'Filter'
    errs[filterFieldId(idPrefix, filter.id)] = `${side} ${index + 1}: ${message}`
  })
  return errs
}

/**
 * Field-keyed validation: each entry maps an input DOM id to its message.
 * Insertion order is top-to-bottom, so the first key is the first offending
 * field to move focus to. Only fields the current kind renders are checked, so
 * re-running this after an edit never leaves an error for a field that is gone.
 */
export function validateDraft(draft: MetricDraft, isNew: boolean): Record<string, string> {
  const errs: Record<string, string> = {}
  if (!draft.displayName.trim()) errs['metric-display-name'] = 'Display name is required.'
  if (isNew && !draft.name.trim()) errs['metric-name'] = 'Internal name is required.'

  if (draft.kind === 'sql') {
    if (!draft.dataSourceId) {
      errs['metric-sql-data-source'] = 'A data source is required for a SQL metric.'
    }
    if (!draft.metricSql.trim()) errs['metric-sql-query'] = 'The metric SQL query is required.'
    if (!draft.sqlTimeColumn.trim()) {
      errs['metric-sql-time'] = 'A time column is required for a SQL metric.'
    }
  } else if (draft.kind === 'fact') {
    if (draft.factComposition === 'ratio') {
      Object.assign(errs, operandErrors(draft.numeratorOp, 'metric-fact-num', 'numerator'))
      Object.assign(errs, operandErrors(draft.denominatorOp, 'metric-fact-den', 'denominator'))
    } else {
      Object.assign(errs, operandErrors(draft.numeratorOp, 'metric-fact', ''))
    }
  } else {
    if (!draft.numeratorEventId && !draft.numeratorEventTypeId) {
      errs['metric-numerator'] =
        draft.composition === 'ratio' ? 'A numerator event is required.' : 'An event is required.'
    }
    if (
      draft.composition === 'ratio'
      && !draft.denominatorEventId
      && !draft.denominatorEventTypeId
    ) {
      errs['metric-denominator'] = 'A denominator event is required for a ratio metric.'
    }
  }
  return errs
}

// Lives in lib/ since the fact-table form derives its internal name the same
// way; re-exported so the metric form's imports stay in one place.
export { toIdentifier } from '@/lib/identifier'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Columns of the schema tables a SQL query names, de-duplicated in schema
 * order and capped. The breakdown picker and the column inputs used to offer
 * every column of every table in the warehouse — thousands of checkboxes on a
 * real one, most of which the query never projects (MET-17). A table counts as
 * named when its name, or the part after its database qualifier, appears in
 * the SQL as a whole word.
 */
export function columnsOfReferencedTables(
  tables: readonly { name: string; columns: readonly { name: string }[] }[],
  sql: string,
  limit = 200,
): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  if (!sql.trim()) return names
  for (const table of tables) {
    const bare = table.name.slice(table.name.lastIndexOf('.') + 1)
    const pattern = new RegExp(`(^|\\W)${escapeRegExp(bare)}(?!\\w)`, 'i')
    if (!pattern.test(sql)) continue
    for (const column of table.columns) {
      if (seen.has(column.name)) continue
      seen.add(column.name)
      names.push(column.name)
      if (names.length >= limit) return names
    }
  }
  return names
}
